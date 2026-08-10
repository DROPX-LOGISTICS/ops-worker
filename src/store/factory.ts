import type { Env } from '../types';
import type { OverrideStore } from './OverrideStore';
import { SupabaseOverrideStore } from './SupabaseOverrideStore';
import type { CredentialStore } from './CredentialStore';
import { SupabaseCredentialStore } from './SupabaseCredentialStore';
import type { WorkforceSessionStore } from './WorkforceSessionStore';
import { SupabaseWorkforceSessionStore } from './SupabaseWorkforceSessionStore';
import { WorkforceAssociateStore } from './WorkforceAssociateStore';
import { CiaSnapshotStore } from './CiaSnapshotStore';
import { ApiResponseCacheStore } from './ApiResponseCacheStore';

export function createOverrideStore(env: Env): OverrideStore {
  return new SupabaseOverrideStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createCredentialStore(env: Env): CredentialStore {
  return new SupabaseCredentialStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createWorkforceSessionStore(env: Env): WorkforceSessionStore {
  return new SupabaseWorkforceSessionStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createWorkforceAssociateStore(env: Env): WorkforceAssociateStore {
  return new WorkforceAssociateStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createCiaSnapshotStore(env: Env): CiaSnapshotStore {
  return new CiaSnapshotStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createApiResponseCacheStore(env: Env): ApiResponseCacheStore {
  return new ApiResponseCacheStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}