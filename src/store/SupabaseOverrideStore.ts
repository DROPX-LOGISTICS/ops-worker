import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { OverrideStore, ValidationRunRecord, OverrideRecord } from './OverrideStore';

export class SupabaseOverrideStore implements OverrideStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    // Service-role key + persistSession:false — this runs server-side in the
    // Worker, never in a browser, and must bypass RLS to write audit rows.
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  async recordRun(run: ValidationRunRecord): Promise<string | undefined> {
    const { data, error } = await this.client
      .from('validation_runs')
      .insert({
        station_code: run.stationCode,
        business_date: run.businessDate,
        denomination_total: run.denominationTotal,
        status: run.status,
        blocked_at: run.blockedAt ?? null,
        steps: run.steps,
      })
      .select('id')
      .single();

    if (error) {
      // Never fail the whole request just because the audit write failed —
      // log it and let the pipeline result still reach the frontend.
      console.error('SupabaseOverrideStore.recordRun failed', error);
      return undefined;
    }
    return data?.id as string | undefined;
  }

  async recordOverride(override: OverrideRecord): Promise<void> {
    const { error } = await this.client.from('validation_overrides').insert({
      run_id: override.runId ?? null,
      station_code: override.stationCode,
      business_date: override.businessDate,
      check_name: override.checkName,
      reason: override.reason,
      overridden_by: override.overriddenBy,
      details: override.details ?? null,
    });

    if (error) {
      console.error('SupabaseOverrideStore.recordOverride failed', error);
      // Overrides are the one write we do want to fail loudly for — the
      // whole point is an auditable reason, so don't silently continue.
      throw error;
    }
  }
}
