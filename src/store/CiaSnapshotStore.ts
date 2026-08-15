import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CIA_CHUNK_PENDING_MARKER,
  CIA_PROCESSING_MARKER,
  CIA_PROCESSING_STALE_MS,
  CIA_RETRY_PENDING_MARKER,
} from '../config';
import type {
  CiaSnapshotRun,
  CiaSnapshotRunStatus,
  CiaStationPayload,
  CiaStationSnapshot,
  CiaStationSnapshotStatus,
  CiaStationSummary,
} from '../types';

interface RunRow {
  id: string;
  as_of_date: string;
  window_from: string;
  window_to: string;
  status: CiaSnapshotRunStatus;
  started_at: string;
  finished_at: string | null;
  stations_total: number;
  stations_ok: number;
  stations_failed: number;
  next_station_index: number;
  error: string | null;
}

interface StationRow {
  run_id: string;
  station_code: string;
  account_key: string;
  status: CiaStationSnapshotStatus;
  error: string | null;
  fetched_at: string;
  summary: CiaStationSummary;
  payload: CiaStationPayload;
}

function toRun(row: RunRow): CiaSnapshotRun {
  return {
    id: row.id,
    asOfDate: row.as_of_date,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stationsTotal: row.stations_total,
    stationsOk: row.stations_ok,
    stationsFailed: row.stations_failed,
    nextStationIndex: row.next_station_index,
    error: row.error,
  };
}

function toStation(row: StationRow): CiaStationSnapshot {
  return {
    runId: row.run_id,
    stationCode: row.station_code,
    accountKey: row.account_key,
    status: row.status,
    error: row.error,
    fetchedAt: row.fetched_at,
    summary: row.summary ?? emptySummary(),
    payload: row.payload ?? emptyPayload(),
  };
}

function emptySummary(): CiaStationSummary {
  return {
    ciaTotal: 0,
    cashAtStationTotal: 0,
    ageingTotal: 0,
    depositedTotal: 0,
    pendingLiability: 0,
    clearedInWindow: 0,
    cashDifference: 0,
    difference: 0,
    shipmentCount: 0,
    pendingDriverCount: 0,
    limitedByRemittanceWindow: false,
    alignedFromDate: '',
  };
}

function emptyPayload(): CiaStationPayload {
  return {
    window: { from: '', to: '' },
    summary: emptySummary(),
    ledger: [],
    pendingDrivers: [],
  };
}

function isProcessingSnapshot(row: Pick<StationRow, 'error' | 'status'> | CiaStationSnapshot): boolean {
  return row.status === 'error' && row.error === CIA_PROCESSING_MARKER;
}

function isRetryPendingSnapshot(row: Pick<StationRow, 'error' | 'status'> | CiaStationSnapshot): boolean {
  return row.status === 'error' && row.error === CIA_RETRY_PENDING_MARKER;
}

function isChunkPendingSnapshot(row: Pick<StationRow, 'error' | 'status'> | CiaStationSnapshot): boolean {
  return row.status === 'error' && row.error === CIA_CHUNK_PENDING_MARKER;
}

function isClaimableSnapshot(row: Pick<CiaStationSnapshot, 'error' | 'status' | 'fetchedAt'>): boolean {
  if (isRetryPendingSnapshot(row) || isChunkPendingSnapshot(row)) return true;
  if (isProcessingSnapshot(row) && isStaleFetchedAt(row.fetchedAt)) return true;
  return false;
}

function isStaleFetchedAt(fetchedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(fetchedAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts >= CIA_PROCESSING_STALE_MS;
}

export class CiaSnapshotStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async createRun(args: {
    asOfDate: string;
    windowFrom: string;
    windowTo: string;
    stationsTotal: number;
  }): Promise<CiaSnapshotRun> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .insert({
        as_of_date: args.asOfDate,
        window_from: args.windowFrom,
        window_to: args.windowTo,
        status: 'running',
        stations_total: args.stationsTotal,
        stations_ok: 0,
        stations_failed: 0,
        next_station_index: 0,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create cia snapshot run: ${error?.message ?? 'no data'}`);
    }
    return toRun(data as RunRow);
  }

  async getRun(runId: string): Promise<CiaSnapshotRun | null> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();

    if (error) {
      console.error('CiaSnapshotStore.getRun failed', error);
      return null;
    }
    return data ? toRun(data as RunRow) : null;
  }

  /** Latest run that finished (completed or completed_with_errors). */
  async getLatestReadableRun(): Promise<CiaSnapshotRun | null> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .select('*')
      .in('status', ['completed', 'completed_with_errors'])
      .order('as_of_date', { ascending: false })
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('CiaSnapshotStore.getLatestReadableRun failed', error);
      return null;
    }
    return data ? toRun(data as RunRow) : null;
  }

  /**
   * Best completed network run: prefer fullest station coverage, not a
   * one-station "completed" patch that would hide the prior full network view.
   */
  async getBestCompletedNetworkRun(minStationsOk = 2): Promise<CiaSnapshotRun | null> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .select('*')
      .in('status', ['completed', 'completed_with_errors'])
      .order('as_of_date', { ascending: false })
      .order('stations_ok', { ascending: false })
      .order('finished_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('CiaSnapshotStore.getBestCompletedNetworkRun failed', error);
      return null;
    }
    const rows = ((data as RunRow[] | null) ?? []).map(toRun);
    // Prefer real finished coverage (stations_ok), never stations_total alone —
    // a 1-station patch still has stations_total = full network size.
    const ranked = [...rows].sort((a, b) => {
      if (b.stationsOk !== a.stationsOk) return b.stationsOk - a.stationsOk;
      if (b.asOfDate !== a.asOfDate) return b.asOfDate.localeCompare(a.asOfDate);
      return String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? ''));
    });
    const full = ranked.find((r) => r.stationsOk >= minStationsOk);
    return full ?? ranked[0] ?? null;
  }

  /**
   * Run to show on the network page:
   * Prefer the fullest completed multi-station run.
   * If a refresh is running, still show that full completed view and attach
   * progress separately — never replace the network list with 1 fresh station.
   */
  async resolveNetworkRun(fullStationCount: number): Promise<{
    run: CiaSnapshotRun | null;
    source: 'running' | 'completed' | 'none';
    progress: CiaSnapshotRun | null;
  }> {
    const minOk = Math.max(2, Math.floor(fullStationCount * 0.25));
    const best = await this.getBestCompletedNetworkRun(minOk);
    const running = await this.getActiveRunningRun();

    if (best) {
      return { run: best, source: 'completed', progress: running };
    }

    // No solid completed run yet — only then show in-progress stations.
    if (running) {
      const finished = await this.listFinishedStationSnapshots(running.id);
      if (finished.length > 0) {
        return { run: running, source: 'running', progress: running };
      }
    }

    const latest = await this.getLatestReadableRun();
    return { run: latest, source: latest ? 'completed' : 'none', progress: running };
  }

  /** Readable run for a specific as-of date (most recent finished if duplicates). */
  async getReadableRunByAsOfDate(asOfDate: string): Promise<CiaSnapshotRun | null> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .select('*')
      .eq('as_of_date', asOfDate)
      .in('status', ['completed', 'completed_with_errors'])
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('CiaSnapshotStore.getReadableRunByAsOfDate failed', error);
      return null;
    }
    return data ? toRun(data as RunRow) : null;
  }

  /** Finished runs since a calendar date (for report-date picker). */
  async listReadableRunsSince(sinceDate: string, limit = 120): Promise<CiaSnapshotRun[]> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .select('*')
      .in('status', ['completed', 'completed_with_errors'])
      .gte('as_of_date', sinceDate)
      .order('as_of_date', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('CiaSnapshotStore.listReadableRunsSince failed', error);
      return [];
    }
    return ((data as RunRow[] | null) ?? []).map(toRun);
  }

  /** Most recent running run (for continuation / avoid duplicates). */
  async getActiveRunningRun(): Promise<CiaSnapshotRun | null> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .select('*')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('CiaSnapshotStore.getActiveRunningRun failed', error);
      return null;
    }
    return data ? toRun(data as RunRow) : null;
  }

  async updateRunProgress(args: {
    runId: string;
    nextStationIndex: number;
    stationsOk: number;
    stationsFailed: number;
  }): Promise<void> {
    const { error } = await this.client
      .from('cia_snapshot_runs')
      .update({
        next_station_index: args.nextStationIndex,
        stations_ok: args.stationsOk,
        stations_failed: args.stationsFailed,
      })
      .eq('id', args.runId);

    if (error) {
      throw new Error(`Failed to update cia run progress: ${error.message}`);
    }
  }

  /**
   * Atomically claim station at `expectedIndex` by bumping next_station_index.
   * Prefer {@link tryClaimStation} for the station-first workflow.
   */
  async claimNextStation(runId: string, expectedIndex: number): Promise<boolean> {
    const { data, error } = await this.client
      .from('cia_snapshot_runs')
      .update({ next_station_index: expectedIndex + 1 })
      .eq('id', runId)
      .eq('next_station_index', expectedIndex)
      .eq('status', 'running')
      .select('id');

    if (error) {
      console.error('CiaSnapshotStore.claimNextStation failed', error);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  /**
   * Claim one station for exclusive processing by inserting a processing marker.
   * Returns false if another tick owns it (fresh marker) or a finished snapshot exists.
   * Stale markers (Worker killed mid-tick) are reclaimed.
   */
  async tryClaimStation(args: {
    runId: string;
    stationCode: string;
    accountKey: string;
    windowFrom: string;
    windowTo: string;
  }): Promise<boolean> {
    const existing = await this.getStationSnapshot(args.runId, args.stationCode);
    if (existing) {
      if (!isClaimableSnapshot(existing)) return false;
      const { data, error } = await this.client
        .from('cia_station_snapshots')
        .update({
          account_key: args.accountKey,
          status: 'error',
          error: CIA_PROCESSING_MARKER,
          fetched_at: new Date().toISOString(),
        })
        .eq('run_id', args.runId)
        .eq('station_code', args.stationCode)
        .eq('error', existing.error)
        .select('station_code');
      if (error) {
        console.error('CiaSnapshotStore.tryClaimStation reclaim failed', error);
        return false;
      }
      return (data?.length ?? 0) > 0;
    }

    const { error } = await this.client.from('cia_station_snapshots').insert({
      run_id: args.runId,
      station_code: args.stationCode,
      account_key: args.accountKey,
      status: 'error',
      error: CIA_PROCESSING_MARKER,
      fetched_at: new Date().toISOString(),
      summary: emptySummary(),
      payload: {
        window: { from: args.windowFrom, to: args.windowTo },
        summary: emptySummary(),
        ledger: [],
        pendingDrivers: [],
      },
    });

    if (!error) return true;
    // Unique violation — another tick inserted first.
    if (String(error.code ?? '') === '23505' || /duplicate|unique/i.test(error.message ?? '')) {
      return false;
    }
    console.error('CiaSnapshotStore.tryClaimStation insert failed', error);
    return false;
  }

  /** Keep a PROCESSING claim alive while a long BFF chunked refresh is still working. */
  async touchProcessingClaim(runId: string, stationCode: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('cia_station_snapshots')
      .update({ fetched_at: new Date().toISOString() })
      .eq('run_id', runId)
      .eq('station_code', stationCode)
      .eq('status', 'error')
      .eq('error', CIA_PROCESSING_MARKER)
      .select('station_code');
    if (error) {
      console.error('CiaSnapshotStore.touchProcessingClaim failed', error);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  /** Recount finished snapshots and sync run counters (excludes in-flight / queued-retry markers). */
  async syncRunCountersFromSnapshots(runId: string): Promise<{
    stationsOk: number;
    stationsFailed: number;
    finishedCount: number;
    inFlightCount: number;
    retryQueuedCount: number;
    processingCount: number;
  }> {
    const snaps = await this.listStationSnapshots(runId);
    let stationsOk = 0;
    let stationsFailed = 0;
    let inFlightCount = 0;
    let retryQueuedCount = 0;
    let processingCount = 0;
    for (const s of snaps) {
      if (isProcessingSnapshot(s) || isChunkPendingSnapshot(s)) {
        inFlightCount += 1;
        processingCount += 1;
        continue;
      }
      if (isRetryPendingSnapshot(s)) {
        inFlightCount += 1;
        retryQueuedCount += 1;
        continue;
      }
      if (s.status === 'ok') stationsOk += 1;
      else stationsFailed += 1;
    }
    const finishedCount = stationsOk + stationsFailed;
    await this.client
      .from('cia_snapshot_runs')
      .update({
        stations_ok: stationsOk,
        stations_failed: stationsFailed,
        next_station_index: finishedCount + inFlightCount,
      })
      .eq('id', runId);
    return {
      stationsOk,
      stationsFailed,
      finishedCount,
      inFlightCount,
      retryQueuedCount,
      processingCount,
    };
  }

  async incrementRunCounters(args: {
    runId: string;
    stationsOk: number;
    stationsFailed: number;
  }): Promise<void> {
    const { error } = await this.client
      .from('cia_snapshot_runs')
      .update({ stations_ok: args.stationsOk, stations_failed: args.stationsFailed })
      .eq('id', args.runId);

    if (error) {
      throw new Error(`Failed to update cia run counters: ${error.message}`);
    }
  }

  async finalizeRun(args: {
    runId: string;
    status: Exclude<CiaSnapshotRunStatus, 'running'>;
    stationsOk: number;
    stationsFailed: number;
    error?: string | null;
  }): Promise<void> {
    const { error } = await this.client
      .from('cia_snapshot_runs')
      .update({
        status: args.status,
        stations_ok: args.stationsOk,
        stations_failed: args.stationsFailed,
        finished_at: new Date().toISOString(),
        error: args.error ?? null,
      })
      .eq('id', args.runId)
      .eq('status', 'running');

    if (error) {
      throw new Error(`Failed to finalize cia run: ${error.message}`);
    }
  }

  async upsertStationSnapshot(args: {
    runId: string;
    stationCode: string;
    accountKey: string;
    status: CiaStationSnapshotStatus;
    error?: string | null;
    summary: CiaStationSummary;
    payload: CiaStationPayload;
  }): Promise<void> {
    const { error } = await this.client.from('cia_station_snapshots').upsert(
      {
        run_id: args.runId,
        station_code: args.stationCode,
        account_key: args.accountKey,
        status: args.status,
        error: args.error ?? null,
        fetched_at: new Date().toISOString(),
        summary: args.summary,
        payload: args.payload,
      },
      { onConflict: 'run_id,station_code' },
    );

    if (error) {
      throw new Error(`Failed to upsert cia station snapshot: ${error.message}`);
    }
  }

  async getStationSnapshot(
    runId: string,
    stationCode: string,
  ): Promise<CiaStationSnapshot | null> {
    const { data, error } = await this.client
      .from('cia_station_snapshots')
      .select('*')
      .eq('run_id', runId)
      .eq('station_code', stationCode)
      .maybeSingle();

    if (error) {
      console.error('CiaSnapshotStore.getStationSnapshot failed', error);
      return null;
    }
    return data ? toStation(data as StationRow) : null;
  }

  async listStationSnapshots(runId: string): Promise<CiaStationSnapshot[]> {
    const { data, error } = await this.client
      .from('cia_station_snapshots')
      .select('*')
      .eq('run_id', runId)
      .order('station_code', { ascending: true });

    if (error) {
      console.error('CiaSnapshotStore.listStationSnapshots failed', error);
      return [];
    }
    return ((data as StationRow[] | null) ?? []).map(toStation);
  }

  /** Finished snapshots only (excludes in-flight and queued-retry markers). */
  async listFinishedStationSnapshots(runId: string): Promise<CiaStationSnapshot[]> {
    const all = await this.listStationSnapshots(runId);
    return all.filter(
      (s) => !isProcessingSnapshot(s) && !isRetryPendingSnapshot(s) && !isChunkPendingSnapshot(s),
    );
  }

  /**
   * Latest finished snapshot for one station across any run (newest fetched_at).
   * Used when the preferred network run does not yet include this station.
   */
  async getLatestFinishedStationSnapshot(
    stationCode: string,
  ): Promise<{ snap: CiaStationSnapshot; run: CiaSnapshotRun | null } | null> {
    const { data, error } = await this.client
      .from('cia_station_snapshots')
      .select('*')
      .eq('station_code', stationCode)
      .eq('status', 'ok')
      .order('fetched_at', { ascending: false })
      .limit(8);

    if (error) {
      console.error('CiaSnapshotStore.getLatestFinishedStationSnapshot failed', error);
      return null;
    }

    const rows = ((data as StationRow[] | null) ?? [])
      .map(toStation)
      .filter((s) => !isProcessingSnapshot(s) && !isRetryPendingSnapshot(s) && !isChunkPendingSnapshot(s));
    const snap = rows[0];
    if (!snap) return null;
    const run = await this.getRun(snap.runId);
    return { snap, run };
  }
}
