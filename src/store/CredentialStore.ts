import type { StoredCredential } from '../types';

/**
 * Persistence for the single owner-uploaded Amazon station-portal session
 * (cookie + x-api-usage-key). The worker holds no long-lived Amazon
 * credentials of its own — this is just the last session the owner copied
 * out of their browser, reused for every /api/admin/validate call until Amazon
 * invalidates it.
 *
 * Swapping Supabase for D1/Postgres/etc. means implementing this interface
 * and updating store/factory.ts — nothing else in the codebase needs to
 * change.
 */
export interface CredentialStore {
  /** The current usable session, or null if none has been uploaded / all are expired. */
  getActive(): Promise<StoredCredential | null>;
  /** Most recently uploaded session regardless of status — used for the admin status view. */
  getLatest(): Promise<StoredCredential | null>;
  /** Stores a newly uploaded session and supersedes any previously active one. */
  upload(cookie: string, xApiUsageKey: string, uploadedBy: string): Promise<StoredCredential>;
  /** Marks a session (defaults to whichever is currently active) as expired. */
  markExpired(id?: string): Promise<void>;
}