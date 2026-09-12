import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timeoutFetch } from '../utils/timeoutFetch';
import { amazonSessionRpc } from '../session/amazonSessionProtocol';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import type { CredentialStore } from './CredentialStore';
import type { StoredCredential } from '../types';

interface SessionRow {
  id: string;
  cookie: string;
  x_api_usage_key: string;
  uploaded_by: string;
  status: 'active' | 'expired';
  created_at: string;
  expired_at: string | null;
  account_key?: string | null;
}

function normalizeAccountKey(accountKey?: string | null): string {
  const key = (accountKey ?? DEFAULT_PORTAL_ACCOUNT).trim();
  return key || DEFAULT_PORTAL_ACCOUNT;
}

function toStoredCredential(row: SessionRow): StoredCredential {
  return {
    id: row.id,
    cookie: row.cookie,
    xApiUsageKey: row.x_api_usage_key,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.created_at,
    status: row.status,
    expiredAt: row.expired_at,
    accountKey: row.account_key ?? DEFAULT_PORTAL_ACCOUNT,
  };
}

export class SupabaseCredentialStore implements CredentialStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false }, global: { fetch: timeoutFetch() } });
  }

  async getActive(accountKey?: string): Promise<StoredCredential | null> {
    const key = normalizeAccountKey(accountKey);
    let query = this.client
      .from('amazon_sessions')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);

    query = this.withAccountFilter(query, key);

    const { data, error } = await query.maybeSingle();
    if (error) {
      // Pre-migration DBs may lack account_key — fall back to global active for default.
      if (key === DEFAULT_PORTAL_ACCOUNT && this.isMissingAccountKey(error)) {
        return this.getActiveLegacy();
      }
      // A database outage is not evidence of a missing Amazon session.
      throw new Error('Amazon active-session lookup unavailable.');
    }
    return data ? toStoredCredential(data as SessionRow) : null;
  }

  async getLatest(accountKey?: string): Promise<StoredCredential | null> {
    const key = normalizeAccountKey(accountKey);
    let query = this.client
      .from('amazon_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    query = this.withAccountFilter(query, key);

    const { data, error } = await query.maybeSingle();
    if (error) {
      if (key === DEFAULT_PORTAL_ACCOUNT && this.isMissingAccountKey(error)) {
        return this.getLatestLegacy();
      }
      console.error('SupabaseCredentialStore.getLatest failed', error);
      return null;
    }
    return data ? toStoredCredential(data as SessionRow) : null;
  }

  async upload(
    cookie: string, xApiUsageKey: string, uploadedBy: string,
    accountKey?: string, loginLeaseToken?: string,
  ): Promise<StoredCredential> {
    const data = await amazonSessionRpc(this.client, 'amazon_replace_session_v1', {
      p_account_key: normalizeAccountKey(accountKey), p_session_id: crypto.randomUUID(),
      p_cookie: cookie, p_api_key: xApiUsageKey, p_uploaded_by: uploadedBy,
      p_token: loginLeaseToken ?? null,
    });
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || row.status !== 'active') throw new Error('Amazon session replacement was not confirmed.');
    return toStoredCredential(row as SessionRow);
  }

  async markExpired(id?: string, accountKey?: string): Promise<void> {
    // Existing callers may supply a dedicated account's session ID alone.
    let key = accountKey;
    if (id && !key) {
      const { data, error } = await this.client.from('amazon_sessions')
        .select('account_key').eq('id', id).maybeSingle();
      if (error) throw new Error('Amazon session identity lookup unavailable.');
      if (!data) return;
      key = data.account_key;
    }
    key = normalizeAccountKey(key);
    const target = id ?? (await this.getActive(key))?.id;
    if (!target) return;
    await amazonSessionRpc(this.client, 'amazon_expire_session_v1', {
      p_account_key: key, p_session_id: target,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private withAccountFilter(query: any, accountKey: string) {
    return query.eq('account_key', accountKey);
  }

  private isMissingAccountKey(error: { message?: string; code?: string }): boolean {
    const msg = `${error.message ?? ''} ${error.code ?? ''}`.toLowerCase();
    return msg.includes('account_key') || msg.includes('42703');
  }

  private async getActiveLegacy(): Promise<StoredCredential | null> {
    const { data, error } = await this.client
      .from('amazon_sessions')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error('Amazon active-session lookup unavailable.');
    }
    return data ? toStoredCredential(data as SessionRow) : null;
  }

  private async getLatestLegacy(): Promise<StoredCredential | null> {
    const { data, error } = await this.client
      .from('amazon_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('SupabaseCredentialStore.getLatestLegacy failed', error);
      return null;
    }
    return data ? toStoredCredential(data as SessionRow) : null;
  }
}
