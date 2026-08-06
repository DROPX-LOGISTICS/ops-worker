import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
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
      console.error('SupabaseCredentialStore.getActive failed', error);
      return null;
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
    cookie: string,
    xApiUsageKey: string,
    uploadedBy: string,
    accountKey?: string,
  ): Promise<StoredCredential> {
    const key = normalizeAccountKey(accountKey);

    // Only supersede active sessions for this account.
    let supersede = this.client
      .from('amazon_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('status', 'active');
    supersede = this.withAccountFilter(supersede, key);
    const { error: supersedeError } = await supersede;
    if (supersedeError && !this.isMissingAccountKey(supersedeError)) {
      console.error('SupabaseCredentialStore.upload: failed to supersede previous session', supersedeError);
    } else if (supersedeError && key === DEFAULT_PORTAL_ACCOUNT) {
      await this.client
        .from('amazon_sessions')
        .update({ status: 'expired', expired_at: new Date().toISOString() })
        .eq('status', 'active');
    }

    const insertPayload: Record<string, unknown> = {
      cookie,
      x_api_usage_key: xApiUsageKey,
      uploaded_by: uploadedBy,
      status: 'active',
      account_key: key,
    };

    let { data, error } = await this.client
      .from('amazon_sessions')
      .insert(insertPayload)
      .select('*')
      .single();

    // Pre-migration: retry without account_key for default account only.
    if (error && this.isMissingAccountKey(error) && key === DEFAULT_PORTAL_ACCOUNT) {
      const retry = await this.client
        .from('amazon_sessions')
        .insert({
          cookie,
          x_api_usage_key: xApiUsageKey,
          uploaded_by: uploadedBy,
          status: 'active',
        })
        .select('*')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error || !data) {
      throw new Error(`Failed to store uploaded Amazon session (${key}): ${error?.message ?? 'unknown error'}`);
    }
    return toStoredCredential(data as SessionRow);
  }

  async markExpired(id?: string, accountKey?: string): Promise<void> {
    const key = normalizeAccountKey(accountKey);
    let query = this.client
      .from('amazon_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('status', 'active');

    if (id) {
      query = query.eq('id', id);
    } else {
      query = this.withAccountFilter(query, key);
    }

    const { error } = await query;
    if (error) {
      console.error('SupabaseCredentialStore.markExpired failed', error);
    }
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
      console.error('SupabaseCredentialStore.getActiveLegacy failed', error);
      return null;
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
