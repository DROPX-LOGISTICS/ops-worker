import type { StoredCredential } from '../types';

/**
 * Persistence for Amazon station-portal sessions (cookie + x-api-usage-key).
 * Sessions are scoped by portal `accountKey` so dedicated-station logins
 * (KDJG / JUGF / AWEZ / KGQE / HBSC) do not overwrite the shared default session.
 */
export interface CredentialStore {
  /** Current usable session for an account, or null. */
  getActive(accountKey?: string): Promise<StoredCredential | null>;
  /** Most recently uploaded session for an account regardless of status. */
  getLatest(accountKey?: string): Promise<StoredCredential | null>;
  /** Stores a new session and supersedes any previously active one for that account. */
  upload(
    cookie: string,
    xApiUsageKey: string,
    uploadedBy: string,
    accountKey?: string,
  ): Promise<StoredCredential>;
  /** Marks a session (defaults to active for the account) as expired. */
  markExpired(id?: string, accountKey?: string): Promise<void>;
}
