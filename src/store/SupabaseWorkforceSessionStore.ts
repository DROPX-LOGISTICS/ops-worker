import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import type { WorkforceSessionStore } from './WorkforceSessionStore';
import type { StoredWorkforceSession } from '../types';

interface SessionRow {
  id: string;
  cookie: string;
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

function toStored(row: SessionRow): StoredWorkforceSession {
  return {
    id: row.id,
    cookie: row.cookie,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.created_at,
    status: row.status,
    expiredAt: row.expired_at,
    accountKey: row.account_key ?? DEFAULT_PORTAL_ACCOUNT,
  };
}

export class SupabaseWorkforceSessionStore implements WorkforceSessionStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async getActive(accountKey?: string): Promise<StoredWorkforceSession | null> {
    const key = normalizeAccountKey(accountKey);
    const { data, error } = await this.client
      .from('workforce_sessions')
      .select('*')
      .eq('status', 'active')
      .eq('account_key', key)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('SupabaseWorkforceSessionStore.getActive failed', error);
      return null;
    }
    return data ? toStored(data as SessionRow) : null;
  }

  async getLatest(accountKey?: string): Promise<StoredWorkforceSession | null> {
    const key = normalizeAccountKey(accountKey);
    const { data, error } = await this.client
      .from('workforce_sessions')
      .select('*')
      .eq('account_key', key)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('SupabaseWorkforceSessionStore.getLatest failed', error);
      return null;
    }
    return data ? toStored(data as SessionRow) : null;
  }

  async upload(
    cookie: string,
    uploadedBy: string,
    accountKey?: string,
  ): Promise<StoredWorkforceSession> {
    const key = normalizeAccountKey(accountKey);

    await this.client
      .from('workforce_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('status', 'active')
      .eq('account_key', key);

    const { data, error } = await this.client
      .from('workforce_sessions')
      .insert({
        cookie,
        uploaded_by: uploadedBy,
        status: 'active',
        account_key: key,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to store workforce session: ${error?.message ?? 'unknown'}`);
    }
    return toStored(data as SessionRow);
  }

  async markExpired(id: string): Promise<void> {
    const { error } = await this.client
      .from('workforce_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      console.error('SupabaseWorkforceSessionStore.markExpired failed', error);
    }
  }
}
