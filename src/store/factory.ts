import type { Env } from '../types';
import type { OverrideStore } from './OverrideStore';
import { SupabaseOverrideStore } from './SupabaseOverrideStore';

export function createOverrideStore(env: Env): OverrideStore {
  return new SupabaseOverrideStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
