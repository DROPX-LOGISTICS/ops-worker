import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import type { Env } from '../types';
import { timeoutFetch } from '../utils/timeoutFetch';
import { amazonSessionRpc, loginFailureCooldown } from '../session/amazonSessionProtocol';

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

function envBootstrapForAccount(
  env: Env,
  accountKey: string,
): { email: string; password: string; defaultStationCode: string } | null {
  if (accountKey !== DEFAULT_PORTAL_ACCOUNT) return null;
  const email = env.AMAZON_PORTAL_EMAIL?.trim();
  const password = env.AMAZON_PORTAL_PASSWORD?.trim();
  if (!email || !password) return null;
  return {
    email,
    password,
    defaultStationCode: env.AMAZON_LOGIN_STATION_CODE || 'TIRC',
  };
}

/**
 * Editable Amazon portal email/password used by Puppeteer auto-login.
 * Multiple accounts are keyed by `account_key` (default + dedicated stations).
 * Env AMAZON_PORTAL_EMAIL / PASSWORD bootstrap only the `default` account;
 * dedicated stations (AWEZ, HBSC, …) live in amazon_portal_credentials.
 */
export class PortalCredentialStore {
  private readonly client: SupabaseClient;
  private readonly loginTokens = new Map<string, string>();

  constructor(private readonly env: Env) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { fetch: timeoutFetch() },
    });
  }

  async getPublic(accountKey?: string): Promise<PortalCredentialsPublic | { configured: false; accountKey: string }> {
    const key = normalizeAccountKey(accountKey);
    const row = await this.fetchRow(key);
    if (row) return toPublic(row);

    const boot = envBootstrapForAccount(this.env, key);
    if (boot) {
      return {
        accountKey: key,
        email: boot.email,
        passwordPreview: redactPassword(boot.password),
        defaultStationCode: boot.defaultStationCode,
        updatedBy: boot.email,
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

    const boot = envBootstrapForAccount(this.env, key);
    if (boot) {
      return {
        accountKey: key,
        email: boot.email,
        password: boot.password,
        defaultStationCode: boot.defaultStationCode,
        updatedBy: boot.email,
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

  /** Shared, atomic, owner-fenced login lease. Database errors fail closed. */
  async tryAcquireLoginLock(accountKey?: string, ttlSeconds = 300): Promise<boolean> {
    const key = normalizeAccountKey(accountKey);
    const row = await this.fetchRow(key);
    if (!row) {
      const bootstrap = await this.getForLogin(key);
      if (!bootstrap) return false;
      await this.upsert(bootstrap.email, bootstrap.password, bootstrap.defaultStationCode, bootstrap.updatedBy, key);
    }
    const token = crypto.randomUUID();
    const claimed = await amazonSessionRpc(this.client, 'amazon_claim_login_v1', {
      p_account_key: key, p_token: token, p_ttl_seconds: ttlSeconds,
    });
    if (claimed === true) this.loginTokens.set(key, token);
    return claimed === true;
  }

  getLoginLeaseToken(accountKey?: string): string | undefined {
    return this.loginTokens.get(normalizeAccountKey(accountKey));
  }

  async holdLoginLock(error: string, accountKey: string, ttlSeconds: number): Promise<void> {
    await this.finishLogin(false, accountKey, error, ttlSeconds);
  }

  async releaseLoginLock(
    result: { ok: true } | { ok: false; error: string }, accountKey?: string,
  ): Promise<void> {
    await this.finishLogin(result.ok, normalizeAccountKey(accountKey),
      result.ok ? null : result.error, result.ok ? 0 : loginFailureCooldown(result.error));
  }

  private async finishLogin(ok: boolean, accountKey: string, error: string | null, cooldown: number): Promise<void> {
    const key = normalizeAccountKey(accountKey);
    const token = this.loginTokens.get(key);
    if (!token) return;
    await amazonSessionRpc(this.client, 'amazon_finish_login_v1', {
      p_account_key: key, p_token: token, p_ok: ok,
      p_error: error?.slice(0, 1000) ?? null, p_cooldown_seconds: cooldown,
    });
    this.loginTokens.delete(key);
  }

  private async fetchRow(accountKey: string): Promise<CredentialRow | null> {
    const key = normalizeAccountKey(accountKey);
    const { data, error } = await this.client.from('amazon_portal_credentials')
      .select('*').eq('account_key', key).maybeSingle();
    if (error) throw new Error('Amazon portal-credential lookup unavailable.');
    return data ? data as CredentialRow : null;
  }
}
