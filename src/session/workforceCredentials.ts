import type { Env } from '../types';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';

export interface WorkforcePortalCredentials {
  email: string;
  password: string;
  source: 'env';
}

/**
 * Resolve workforce (logistics.amazon.in) login credentials from Worker env.
 */
export function getWorkforcePortalCredentials(env: Env): WorkforcePortalCredentials | null {
  const email = env.WORKFORCE_PORTAL_EMAIL?.trim();
  const password = env.WORKFORCE_PORTAL_PASSWORD?.trim();
  if (!email || !password) return null;
  return { email, password, source: 'env' };
}

export function workforceCredentialsConfigured(env: Env): boolean {
  return Boolean(getWorkforcePortalCredentials(env));
}

/**
 * Short-lived login lock so concurrent ensure/refresh calls don't spawn
 * multiple Browser Rendering sessions.
 */
export class WorkforceLoginStateStore {
  private readonly client: SupabaseClient;

  constructor(env: Env) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }

  async tryAcquireLoginLock(accountKey = DEFAULT_PORTAL_ACCOUNT, ttlSeconds = 150): Promise<boolean> {
    const key = accountKey.trim() || DEFAULT_PORTAL_ACCOUNT;
    const now = Date.now();
    const { data } = await this.client
      .from('workforce_login_state')
      .select('login_locked_until')
      .eq('account_key', key)
      .maybeSingle();

    const lockedUntil = data?.login_locked_until
      ? Date.parse(data.login_locked_until as string)
      : 0;
    if (lockedUntil && lockedUntil > now) {
      return false;
    }

    const until = new Date(now + ttlSeconds * 1000).toISOString();
    const { error } = await this.client.from('workforce_login_state').upsert(
      {
        account_key: key,
        login_locked_until: until,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_key' },
    );

    if (error) {
      console.error('WorkforceLoginStateStore.tryAcquireLoginLock failed', error);
      // Fail open so a missing table doesn't block login forever.
      return true;
    }
    return true;
  }

  async releaseLoginLock(
    result: { ok: true } | { ok: false; error: string },
    accountKey = DEFAULT_PORTAL_ACCOUNT,
  ): Promise<void> {
    const key = accountKey.trim() || DEFAULT_PORTAL_ACCOUNT;
    const patch: Record<string, unknown> = {
      account_key: key,
      login_locked_until: null,
      updated_at: new Date().toISOString(),
    };
    if (result.ok) {
      patch.last_login_at = new Date().toISOString();
      patch.last_login_error = null;
    } else {
      patch.last_login_error = result.error.slice(0, 500);
    }

    const { error } = await this.client
      .from('workforce_login_state')
      .upsert(patch, { onConflict: 'account_key' });

    if (error) {
      console.error('WorkforceLoginStateStore.releaseLoginLock failed', error);
    }
  }

  async getPublic(accountKey = DEFAULT_PORTAL_ACCOUNT): Promise<{
    accountKey: string;
    credentialsConfigured: boolean;
    lastLoginAt: string | null;
    lastLoginError: string | null;
    loginLocked: boolean;
  }> {
    const key = accountKey.trim() || DEFAULT_PORTAL_ACCOUNT;
    const { data } = await this.client
      .from('workforce_login_state')
      .select('last_login_at, last_login_error, login_locked_until')
      .eq('account_key', key)
      .maybeSingle();

    const lockedUntil = data?.login_locked_until
      ? Date.parse(data.login_locked_until as string)
      : 0;

    return {
      accountKey: key,
      credentialsConfigured: false, // filled by caller with env check
      lastLoginAt: (data?.last_login_at as string | null) ?? null,
      lastLoginError: (data?.last_login_error as string | null) ?? null,
      loginLocked: Boolean(lockedUntil && lockedUntil > Date.now()),
    };
  }
}
