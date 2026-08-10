import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
   * Returns false when another invocation already claimed it (or run stopped),
   * so overlapping cron ticks never process the same station twice.
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
      .eq('id', args.runId);

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
}
