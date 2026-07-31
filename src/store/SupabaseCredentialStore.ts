import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  };
}

export class SupabaseCredentialStore implements CredentialStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async getActive(): Promise<StoredCredential | null> {
    const { data, error } = await this.client
      .from('amazon_sessions')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('SupabaseCredentialStore.getActive failed', error);
      return null;
    }
    return data ? toStoredCredential(data as SessionRow) : null;
  }

  async getLatest(): Promise<StoredCredential | null> {
    const { data, error } = await this.client
      .from('amazon_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('SupabaseCredentialStore.getLatest failed', error);
      return null;
    }
    return data ? toStoredCredential(data as SessionRow) : null;
  }

  async upload(cookie: string, xApiUsageKey: string, uploadedBy: string): Promise<StoredCredential> {
    // Only one session is ever "active" at a time — supersede whatever came before it.
    const { error: supersedeError } = await this.client
      .from('amazon_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('status', 'active');

    if (supersedeError) {
      console.error('SupabaseCredentialStore.upload: failed to supersede previous session', supersedeError);
      // Not fatal — proceed to insert the new one regardless.
    }

    const { data, error } = await this.client
      .from('amazon_sessions')
      .insert({ cookie, x_api_usage_key: xApiUsageKey, uploaded_by: uploadedBy, status: 'active' })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to store uploaded Amazon session: ${error?.message ?? 'unknown error'}`);
    }
    return toStoredCredential(data as SessionRow);
  }

  async markExpired(id?: string): Promise<void> {
    let query = this.client
      .from('amazon_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('status', 'active');

    if (id) query = query.eq('id', id);

    const { error } = await query;
    if (error) {
      console.error('SupabaseCredentialStore.markExpired failed', error);
    }
  }
}