import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CashTidSnapshotRow } from '../types';

interface SnapshotRow {
  station_code: string;
  tracking_id: string;
  business_date: string;
  captured_state: string | null;
  expected_amount: number;
  driver_id: string | null;
  first_captured_at: string;
  last_checked_at: string;
}

function toRow(row: SnapshotRow): CashTidSnapshotRow {
  return {
    stationCode: row.station_code,
    trackingId: row.tracking_id,
    businessDate: row.business_date,
    capturedState: row.captured_state,
    expectedAmount: Number(row.expected_amount ?? 0) || 0,
    driverId: row.driver_id,
    firstCapturedAt: row.first_captured_at,
    lastCheckedAt: row.last_checked_at,
  };
}

export type NewCashTid = {
  trackingId: string;
  capturedState: string | null;
  expectedAmount: number;
  driverId: string | null;
};

/**
 * Nightly snapshot of tracking IDs still CASH_AT_STATION at each station. A TID keeps its
 * original businessDate/firstCapturedAt across re-captures (see upsertOpenTids) so a late
 * cash handover still attributes back to the day the shipment was actually delivered.
 */
export class CashTidSnapshotStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  /**
   * Insert newly-seen tracking IDs with `businessDate` as their anchor date; refresh
   * captured_state/last_checked_at on ones already tracked, WITHOUT touching their
   * existing business_date or first_captured_at (that would be exactly the bug this
   * table exists to avoid — re-dating a TID to the night it happened to still be open).
   */
  async upsertOpenTids(stationCode: string, businessDate: string, tids: NewCashTid[]): Promise<void> {
    if (tids.length === 0) return;
    const code = stationCode.trim().toUpperCase();
    const now = new Date().toISOString();

    const existing = await this.client
      .from('cod_cash_tid_snapshots')
      .select('tracking_id')
      .eq('station_code', code)
      .in('tracking_id', tids.map((t) => t.trackingId));
    if (existing.error) throw new Error(`CashTidSnapshotStore.upsertOpenTids select failed: ${existing.error.message}`);
    const alreadyTracked = new Set((existing.data ?? []).map((r) => r.tracking_id as string));

    const toInsert = tids.filter((t) => !alreadyTracked.has(t.trackingId));
    const toRefresh = tids.filter((t) => alreadyTracked.has(t.trackingId));

    if (toInsert.length > 0) {
      const insertResult = await this.client.from('cod_cash_tid_snapshots').insert(
        toInsert.map((t) => ({
          station_code: code,
          tracking_id: t.trackingId,
          business_date: businessDate,
          captured_state: t.capturedState,
          expected_amount: t.expectedAmount,
          driver_id: t.driverId,
          first_captured_at: now,
          last_checked_at: now,
          created_at: now,
          updated_at: now,
        })),
      );
      if (insertResult.error) {
        throw new Error(`CashTidSnapshotStore.upsertOpenTids insert failed: ${insertResult.error.message}`);
      }
    }

    // Supabase-js has no batched "update N rows with different values" — refresh
    // one at a time. Snapshot sizes per station are small (nightly CASH_AT_STATION
    // backlog), so this is a handful of calls, not thousands.
    for (const t of toRefresh) {
      const updateResult = await this.client
        .from('cod_cash_tid_snapshots')
        .update({
          captured_state: t.capturedState,
          expected_amount: t.expectedAmount,
          driver_id: t.driverId,
          last_checked_at: now,
          updated_at: now,
        })
        .eq('station_code', code)
        .eq('tracking_id', t.trackingId);
      if (updateResult.error) {
        throw new Error(`CashTidSnapshotStore.upsertOpenTids refresh failed: ${updateResult.error.message}`);
      }
    }
  }

  async listOpenTids(stationCode: string): Promise<CashTidSnapshotRow[]> {
    const { data, error } = await this.client
      .from('cod_cash_tid_snapshots')
      .select('*')
      .eq('station_code', stationCode.trim().toUpperCase());
    if (error) throw new Error(`CashTidSnapshotStore.listOpenTids failed: ${error.message}`);
    return (data ?? []).map((row) => toRow(row as SnapshotRow));
  }

  /** Tracking IDs anchored to a specific business date (for merging into that date's reconciliation). */
  async listOpenTidsForDate(stationCode: string, businessDate: string): Promise<CashTidSnapshotRow[]> {
    const { data, error } = await this.client
      .from('cod_cash_tid_snapshots')
      .select('*')
      .eq('station_code', stationCode.trim().toUpperCase())
      .eq('business_date', businessDate);
    if (error) throw new Error(`CashTidSnapshotStore.listOpenTidsForDate failed: ${error.message}`);
    return (data ?? []).map((row) => toRow(row as SnapshotRow));
  }

  /** Cash has been accounted for (package moved out of CASH_AT_STATION) — delete the row. */
  async deleteResolved(stationCode: string, trackingIds: string[]): Promise<number> {
    if (trackingIds.length === 0) return 0;
    const { error, count } = await this.client
      .from('cod_cash_tid_snapshots')
      .delete({ count: 'exact' })
      .eq('station_code', stationCode.trim().toUpperCase())
      .in('tracking_id', trackingIds);
    if (error) throw new Error(`CashTidSnapshotStore.deleteResolved failed: ${error.message}`);
    return count ?? 0;
  }

  /** Retention: rows older than this are dropped regardless of resolution status. */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await this.client
      .from('cod_cash_tid_snapshots')
      .delete({ count: 'exact' })
      .lt('first_captured_at', cutoff);
    if (error) throw new Error(`CashTidSnapshotStore.purgeOlderThan failed: ${error.message}`);
    return count ?? 0;
  }
}
