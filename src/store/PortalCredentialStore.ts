import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';

export interface PortalCredentials {
  email: string;
  password: string;
  defaultStationCode: string;
  updatedBy: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastLoginError: string | null;
  loginLockedUntil: string | null;
}

export interface PortalCredentialsPublic {
  email: string;
  passwordPreview: string;
  defaultStationCode: string;
  updatedBy: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastLoginError: string | null;
  configured: true;
}

interface CredentialRow {
  id: number;
  email: string;
  password: string;
  default_station_code: string;
  updated_by: string;
  updated_at: string;
  login_locked_until: string | null;
  last_login_at: string | null;
  last_login_error: string | null;
}

function redactPassword(password: string): string {
  if (password.length <= 2) return '*'.repeat(password.length);
  return `${password[0]}${'*'.repeat(Math.min(password.length - 2, 12))}${password[password.length - 1]}`;
}

function toPublic(row: CredentialRow): PortalCredentialsPublic {
  return {
    email: row.email,
    passwordPreview: redactPassword(row.password),
    defaultStationCode: row.default_station_code,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    lastLoginError: row.last_login_error,
    configured: true,
  };
}

function toCredentials(row: CredentialRow): PortalCredentials {
  return {
    email: row.email,
    password: row.password,
    defaultStationCode: row.default_station_code,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    lastLoginError: row.last_login_error,
    loginLockedUntil: row.login_locked_until,
  };
}

/**
 * Editable Amazon portal email/password used by Puppeteer auto-login.
 * Falls back to AMAZON_PORTAL_EMAIL / AMAZON_PORTAL_PASSWORD env secrets
 * when no DB row exists yet (bootstrap path).
 */
export class PortalCredentialStore {
  private readonly client: SupabaseClient;

  constructor(
    private readonly env: Env,
  ) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }

  async getPublic(): Promise<PortalCredentialsPublic | { configured: false }> {
    const row = await this.fetchRow();
    if (row) return toPublic(row);

    if (this.env.AMAZON_PORTAL_EMAIL && this.env.AMAZON_PORTAL_PASSWORD) {
      return {
        email: this.env.AMAZON_PORTAL_EMAIL,
        passwordPreview: redactPassword(this.env.AMAZON_PORTAL_PASSWORD),
        defaultStationCode: this.env.AMAZON_LOGIN_STATION_CODE || 'TIRC',
        updatedBy: this.env.AMAZON_PORTAL_EMAIL,
        updatedAt: new Date(0).toISOString(),
        lastLoginAt: null,
        lastLoginError: null,
        configured: true,
      };
    }
    return { configured: false };
  }

  async getForLogin(): Promise<PortalCredentials | null> {
    const row = await this.fetchRow();
    if (row) return toCredentials(row);

    if (this.env.AMAZON_PORTAL_EMAIL && this.env.AMAZON_PORTAL_PASSWORD) {
      return {
        email: this.env.AMAZON_PORTAL_EMAIL,
        password: this.env.AMAZON_PORTAL_PASSWORD,
        defaultStationCode: this.env.AMAZON_LOGIN_STATION_CODE || 'TIRC',
        updatedBy: this.env.AMAZON_PORTAL_EMAIL,
        updatedAt: new Date(0).toISOString(),
        lastLoginAt: null,
        lastLoginError: null,
        loginLockedUntil: null,
      };
    }
    return null;
  }

  async upsert(email: string, password: string, defaultStationCode: string, updatedBy: string): Promise<PortalCredentialsPublic> {
    const { data, error } = await this.client
      .from('amazon_portal_credentials')
      .upsert(
        {
          id: 1,
          email,
          password,
          default_station_code: defaultStationCode,
          updated_by: updatedBy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      )
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to store portal credentials: ${error?.message ?? 'unknown error'}`);
    }
    return toPublic(data as CredentialRow);
  }

  /**
   * Acquire a short login lock. Returns false if another login is already in progress.
   */
  async tryAcquireLoginLock(ttlSeconds = 120): Promise<boolean> {
    const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const nowIso = new Date().toISOString();

    // Ensure the singleton row exists so we can lock it.
    let row = await this.fetchRow();
    if (!row) {
      const bootstrap = await this.getForLogin();
      if (!bootstrap) return false;
      await this.upsert(bootstrap.email, bootstrap.password, bootstrap.defaultStationCode, bootstrap.updatedBy);
      row = await this.fetchRow();
    }
    if (!row) return false;

    if (row.login_locked_until && row.login_locked_until > nowIso) {
      return false;
    }

    const { error } = await this.client
      .from('amazon_portal_credentials')
      .update({ login_locked_until: until })
      .eq('id', 1);

    if (error) {
      console.error('PortalCredentialStore.tryAcquireLoginLock failed', error);
      return false;
    }
    return true;
  }

  async releaseLoginLock(result: { ok: true } | { ok: false; error: string }): Promise<void> {
    const patch =
      result.ok
        ? {
            login_locked_until: null,
            last_login_at: new Date().toISOString(),
            last_login_error: null,
          }
        : {
            login_locked_until: null,
            last_login_error: result.error.slice(0, 1000),
          };

    const { error } = await this.client.from('amazon_portal_credentials').update(patch).eq('id', 1);
    if (error) console.error('PortalCredentialStore.releaseLoginLock failed', error);
  }

  private async fetchRow(): Promise<CredentialRow | null> {
    const { data, error } = await this.client
      .from('amazon_portal_credentials')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      console.error('PortalCredentialStore.fetchRow failed', error);
      return null;
    }
    return data as CredentialRow | null;
  }
}
