import type { CheckName, StepResult } from '../types';

export interface ValidationRunRecord {
  stationCode: string;
  businessDate: string;
  denominationTotal: number;
  status: 'passed' | 'blocked';
  blockedAt?: CheckName;
  steps: StepResult[];
}

export interface OverrideRecord {
  runId?: string;
  stationCode: string;
  businessDate: string;
  checkName: CheckName;
  reason: string;
  overriddenBy: string;
  details?: unknown;
}

/**
 * Persistence abstraction for validation runs + manual overrides. Swapping
 * Supabase for Postgres/D1/DynamoDB/etc. means implementing this interface
 * and updating store/factory.ts — the pipeline never touches Supabase directly.
 */
export interface OverrideStore {
  /** Persists an audit record of a full pipeline run. Returns the run id if available. */
  recordRun(run: ValidationRunRecord): Promise<string | undefined>;
  /** Persists a manual override with its reason, tied back to a run if we have one. */
  recordOverride(override: OverrideRecord): Promise<void>;
}
