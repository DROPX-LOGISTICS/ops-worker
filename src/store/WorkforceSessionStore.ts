import type { StoredWorkforceSession } from '../types';

export interface WorkforceSessionStore {
  getActive(accountKey?: string): Promise<StoredWorkforceSession | null>;
  getLatest(accountKey?: string): Promise<StoredWorkforceSession | null>;
  upload(cookie: string, uploadedBy: string, accountKey?: string): Promise<StoredWorkforceSession>;
  markExpired(id: string): Promise<void>;
}
