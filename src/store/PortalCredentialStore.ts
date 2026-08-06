import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import type { Env } from '../types';

export interface PortalCredentials {
  accountKey: string;
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
  accountKey: string;
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
  account_key: string;
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
    accountKey: row.account_key,
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
    accountKey: row.account_key,
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

function normalizeAccountKey(accountKey?: string | null): string {
  const key = (accountKey ?? DEFAULT_PORTAL_ACCOUNT).trim();
  return key || DEFAULT_PORTAL_ACCOUNT;
}

/**
 * Editable Amazon portal email/password used by Puppeteer auto-login.
 * Multiple accounts are keyed by `account_key` (default + dedicated stations).
 * Env AMAZON_PORTAL_EMAIL / PASSWORD bootstrap only the `default` account.
 */
export class PortalCredentialStore {
  private readonly client: SupabaseClient;

  constructor(private readonly env: Env) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }

  async getPublic(accountKey?: string): Promise<PortalCredentialsPublic | { configured: false; accountKey: string }> {
    const key = normalizeAccountKey(accountKey);
    const row = await this.fetchRow(key);
    if (row) return toPublic(row);

    if (key === DEFAULT_PORTAL_ACCOUNT && this.env.AMAZON_PORTAL_EMAIL && this.env.AMAZON_PORTAL_PASSWORD) {
      return {
        accountKey: DEFAULT_PORTAL_ACCOUNT,
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
    return { configured: false, accountKey: key };
  }

  async listPublic(): Promise<PortalCredentialsPublic[]> {
    const { data, error } = await this.client
      .from('amazon_portal_credentials')
      .select('*')
      .order('account_key', { ascending: true });

    if (error) {
      console.error('PortalCredentialStore.listPublic failed', error);
      return [];
    }

    const rows = (data as CredentialRow[] | null) ?? [];
    const listed = rows.map(toPublic);
    if (!listed.some((r) => r.accountKey === DEFAULT_PORTAL_ACCOUNT)) {
      const fallback = await this.getPublic(DEFAULT_PORTAL_ACCOUNT);
      if ('configured' in fallback && fallback.configured) listed.unshift(fallback);
    }
    return listed;
  }

  async getForLogin(accountKey?: string): Promise<PortalCredentials | null> {
    const key = normalizeAccountKey(accountKey);
    const row = await this.fetchRow(key);
    if (row) return toCredentials(row);

    if (key === DEFAULT_PORTAL_ACCOUNT && this.env.AMAZON_PORTAL_EMAIL && this.env.AMAZON_PORTAL_PASSWORD) {
      return {
        accountKey: DEFAULT_PORTAL_ACCOUNT,
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

  async upsert(
    email: string,
    password: string,
    defaultStationCode: string,
    updatedBy: string,
    accountKey?: string,
  ): Promise<PortalCredentialsPublic> {
    const key = normalizeAccountKey(accountKey);
    const { data, error } = await this.client
      .from('amazon_portal_credentials')
      .upsert(
        {
          account_key: key,
          email,
          password,
          default_station_code: defaultStationCode,
          updated_by: updatedBy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_key' },
      )
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to store portal credentials (${key}): ${error?.message ?? 'unknown error'}`);
    }
    return toPublic(data as CredentialRow);
  }

  /**
   * Acquire a short login lock for one account. Returns false if another login
   * for the same account is already in progress.
   */
  async tryAcquireLoginLock(accountKey?: string, ttlSeconds = 120): Promise<boolean> {
    const key = normalizeAccountKey(accountKey);
    const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const nowIso = new Date().toISOString();

    let row = await this.fetchRow(key);
    if (!row) {
      const bootstrap = await this.getForLogin(key);
      if (!bootstrap) return false;
      await this.upsert(
        bootstrap.email,
        bootstrap.password,
        bootstrap.defaultStationCode,
        bootstrap.updatedBy,
        key,
      );
      row = await this.fetchRow(key);
    }
    if (!row) return false;

    if (row.login_locked_until && row.login_locked_until > nowIso) {
      return false;
    }

    const { error } = await this.client
      .from('amazon_portal_credentials')
      .update({ login_locked_until: until })
      .eq('account_key', key);

    if (error) {
      console.error('PortalCredentialStore.tryAcquireLoginLock failed', error);
      return false;
    }
    return true;
  }

  async releaseLoginLock(
    result: { ok: true } | { ok: false; error: string },
    accountKey?: string,
  ): Promise<void> {
    const key = normalizeAccountKey(accountKey);
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

    const { error } = await this.client
      .from('amazon_portal_credentials')
      .update(patch)
      .eq('account_key', key);
    if (error) console.error('PortalCredentialStore.releaseLoginLock failed', error);
  }

  private async fetchRow(accountKey: string): Promise<CredentialRow | null> {
    const key = normalizeAccountKey(accountKey);

    // Preferred: account_key column (after migration).
    const byKey = await this.client
      .from('amazon_portal_credentials')
      .select('*')
      .eq('account_key', key)
      .maybeSingle();

    if (!byKey.error && byKey.data) {
      const row = byKey.data as CredentialRow & { account_key?: string };
      return { ...row, account_key: row.account_key ?? key };
    }

    // Legacy singleton fallback (pre-migration id=1 → default only).
    if (key === DEFAULT_PORTAL_ACCOUNT) {
      const legacy = await this.client
        .from('amazon_portal_credentials')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
      if (legacy.error) {
        console.error('PortalCredentialStore.fetchRow legacy failed', legacy.error);
        return null;
      }
      if (!legacy.data) return null;
      const row = legacy.data as CredentialRow & { account_key?: string };
      return { ...row, account_key: row.account_key ?? DEFAULT_PORTAL_ACCOUNT };
    }

    if (byKey.error && !String(byKey.error.message || '').includes('account_key')) {
      console.error('PortalCredentialStore.fetchRow failed', byKey.error);
    }
    return null;
  }
}
