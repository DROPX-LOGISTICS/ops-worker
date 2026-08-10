import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface CacheRow {
  cache_key: string;
  payload: unknown;
  expires_at: string;
}

/**
 * Supabase-backed short TTL cache. Failures are soft — callers fall back to
 * memory/live compute so a missing table never breaks production APIs.
 */
export class ApiResponseCacheStore {
  private readonly client: SupabaseClient;
  private tableMissing = false;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.tableMissing) return null;
    const { data, error } = await this.client
      .from('api_response_cache')
      .select('payload, expires_at')
      .eq('cache_key', key)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) this.tableMissing = true;
      else console.error('ApiResponseCacheStore.get failed', error.message);
      return null;
    }
    if (!data) return null;

    const row = data as CacheRow;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      // Best-effort delete; ignore errors.
      void this.client.from('api_response_cache').delete().eq('cache_key', key);
      return null;
    }
    return row.payload as T;
  }

  async set(key: string, payload: unknown, ttlMs: number): Promise<void> {
    if (this.tableMissing) return;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const { error } = await this.client.from('api_response_cache').upsert(
      {
        cache_key: key,
        payload,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'cache_key' },
    );
    if (error) {
      if (isMissingTable(error)) this.tableMissing = true;
      else console.error('ApiResponseCacheStore.set failed', error.message);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (this.tableMissing) return;
    // PostgREST: cache_key LIKE 'prefix%'
    const { error } = await this.client
      .from('api_response_cache')
      .delete()
      .like('cache_key', `${prefix}%`);
    if (error) {
      if (isMissingTable(error)) this.tableMissing = true;
      else console.error('ApiResponseCacheStore.deletePrefix failed', error.message);
    }
  }
}

function isMissingTable(error: { message?: string; code?: string }): boolean {
  const msg = (error.message ?? '').toLowerCase();
  return error.code === '42P01' || msg.includes('does not exist') || msg.includes('could not find the table');
}
