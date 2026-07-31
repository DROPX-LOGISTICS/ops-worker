import type { Env } from '../types';
import type { OverrideStore } from './OverrideStore';
import { SupabaseOverrideStore } from './SupabaseOverrideStore';
import type { CredentialStore } from './CredentialStore';
import { SupabaseCredentialStore } from './SupabaseCredentialStore';

export function createOverrideStore(env: Env): OverrideStore {
  return new SupabaseOverrideStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createCredentialStore(env: Env): CredentialStore {
  return new SupabaseCredentialStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}