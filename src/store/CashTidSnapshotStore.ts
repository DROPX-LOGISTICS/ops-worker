import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timeoutFetch } from '../utils/timeoutFetch';
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
  /** Ageing units (paise), same as AgeingPackageDetail.receivableAmount. */
  expectedAmount: number;
  driverId: string | null;
};

/** Keeps `.in(...)` filters well under PostgREST's URL length limit. */
const IN_FILTER_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Per-station ledger of which business date each cash tracking ID belongs to. A TID is
 * anchored to the first date it was seen on and never re-dated, so a late cash handover
 * (which moves lastUpdatedTime to the next day) still attributes back to the delivery
 * day. Rows are kept (not deleted on resolution) until retention so past dates can be
 * re-opened against the same ledger.
 */
export class CashTidSnapshotStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false }, global: { fetch: timeoutFetch() } });
  }

  /**
   * Insert-if-absent: anchor newly-seen TIDs to `businessDate`. TIDs already anchored
   * (to this or any other date) are left untouched — re-dating one to the day it happens
   * to still be open is exactly the bug this table exists to avoid.
   */
  async anchorTids(stationCode: string, businessDate: string, tids: NewCashTid[]): Promise<number> {
    const code = stationCode.trim().toUpperCase();
    const unique = [...new Map(tids.filter((t) => t.trackingId).map((t) => [t.trackingId, t])).values()];
    if (unique.length === 0) return 0;
    const now = new Date().toISOString();

    let inserted = 0;
    for (const batch of chunk(unique, IN_FILTER_CHUNK)) {
      const { error, count } = await this.client.from('cod_cash_tid_snapshots').upsert(
        batch.map((t) => ({
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
        { onConflict: 'station_code,tracking_id', ignoreDuplicates: true, count: 'exact' },
      );
      if (error) throw new Error(`CashTidSnapshotStore.anchorTids failed: ${error.message}`);
      inserted += count ?? 0;
    }
    return inserted;
  }

  /** Tracking IDs anchored to a specific business date (for merging into that date's reconciliation). */
  async listTidsForDate(stationCode: string, businessDate: string): Promise<CashTidSnapshotRow[]> {
    const { data, error } = await this.client
      .from('cod_cash_tid_snapshots')
      .select('*')
      .eq('station_code', stationCode.trim().toUpperCase())
      .eq('business_date', businessDate)
      .limit(5000);
    if (error) throw new Error(`CashTidSnapshotStore.listTidsForDate failed: ${error.message}`);
    return (data ?? []).map((row) => toRow(row as SnapshotRow));
  }

  /** Stored cash amount (paise) per tracking ID, for the given IDs. */
  async listAmountsByTrackingIds(stationCode: string, trackingIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = [...new Set(trackingIds.filter(Boolean))];
    for (const batch of chunk(ids, IN_FILTER_CHUNK)) {
      const { data, error } = await this.client
        .from('cod_cash_tid_snapshots')
        .select('tracking_id, expected_amount')
        .eq('station_code', stationCode.trim().toUpperCase())
        .in('tracking_id', batch);
      if (error) throw new Error(`CashTidSnapshotStore.listAmountsByTrackingIds failed: ${error.message}`);
      for (const row of data ?? []) out.set(row.tracking_id as string, Number(row.expected_amount ?? 0) || 0);
    }
    return out;
  }

  /** One driver's TIDs anchored to any date in [fromDate, toDate] — a tech-issue hold's carried cash. */
  async listTidsForDriverBetween(
    stationCode: string,
    driverId: string,
    fromDate: string,
    toDate: string,
  ): Promise<CashTidSnapshotRow[]> {
    if (!driverId || fromDate > toDate) return [];
    const { data, error } = await this.client
      .from('cod_cash_tid_snapshots')
      .select('*')
      .eq('station_code', stationCode.trim().toUpperCase())
      .ilike('driver_id', driverId.trim())
      .gte('business_date', fromDate)
      .lte('business_date', toDate)
      .limit(5000);
    if (error) throw new Error(`CashTidSnapshotStore.listTidsForDriverBetween failed: ${error.message}`);
    return (data ?? []).map((row) => toRow(row as SnapshotRow));
  }

  /**
   * Of `trackingIds`, the ones anchored to a DIFFERENT business date — cash already
   * claimed by another day. Scoped to the candidate IDs (not the whole station) so the
   * answer never gets truncated by PostgREST's default row cap.
   */
  async listTrackingIdsAnchoredElsewhere(
    stationCode: string,
    businessDate: string,
    trackingIds: string[],
  ): Promise<string[]> {
    const ids = [...new Set(trackingIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const code = stationCode.trim().toUpperCase();
    const out: string[] = [];
    for (const batch of chunk(ids, IN_FILTER_CHUNK)) {
      const { data, error } = await this.client
        .from('cod_cash_tid_snapshots')
        .select('tracking_id')
        .eq('station_code', code)
        .neq('business_date', businessDate)
        .in('tracking_id', batch);
      if (error) {
        throw new Error(`CashTidSnapshotStore.listTrackingIdsAnchoredElsewhere failed: ${error.message}`);
      }
      for (const row of data ?? []) out.push(row.tracking_id as string);
    }
    return out;
  }

  /** Retention: rows whose business date is older than this are dropped. */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { error, count } = await this.client
      .from('cod_cash_tid_snapshots')
      .delete({ count: 'exact' })
      .lt('business_date', cutoff);
    if (error) throw new Error(`CashTidSnapshotStore.purgeOlderThan failed: ${error.message}`);
    return count ?? 0;
  }
}
