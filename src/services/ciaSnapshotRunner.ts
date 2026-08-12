import type { Env, CiaStationPayload, CiaStationSummary, CiaSnapshotRun } from '../types';
import {
  ALLOWED_STATIONS,
  CIA_PROCESSING_MARKER,
  portalAccountKeyForStation,
} from '../config';
import { createCiaSnapshotStore } from '../store/factory';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { loadWorkforceRosterMap } from './workforceRoster';
import { getCiaAnalysisWindow, mergeCiaStationPayloads, reconcileCashInAssociate, splitYmdRange } from './cashInAssociate';
import { CIA_REFRESH_CHUNK_DAYS } from '../config';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyPayload(fromDate: string, toDate: string): CiaStationPayload {
  const summary: CiaStationSummary = {
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
    alignedFromDate: fromDate,
  };
  return { window: { from: fromDate, to: toDate }, summary, ledger: [], pendingDrivers: [] };
}

function stationList(): string[] {
  return [...ALLOWED_STATIONS].sort();
}

function isFinishedSnapshot(status: string, error: string | null | undefined): boolean {
  return !(status === 'error' && error === CIA_PROCESSING_MARKER);
}

/**
 * Reconcile a multi-week window by self-fetching live-range chunks.
 * Each chunk runs in a separate Worker isolate (fresh CPU budget) so large
 * stations like ERSE do not hit Cloudflare Error 1102 on Free plan.
 */
async function reconcileViaLiveChunks(
  env: Env,
  stationCode: string,
  fromDate: string,
  toDate: string,
): Promise<CiaStationPayload> {
  const base = String(env.PUBLIC_WORKER_URL ?? '').trim().replace(/\/$/, '');
  const adminKey = String(env.ADMIN_API_KEY ?? '').trim();
  const chunks = splitYmdRange(fromDate, toDate, CIA_REFRESH_CHUNK_DAYS);

  if (!base || !adminKey || chunks.length <= 1) {
    const session = await ensureValidAmazonSession(env, {
      stationCode,
      triggeredBy: `cia-chunk-fallback:${stationCode}`,
      notifyOnFailure: false,
    });
    if (!session.ok) {
      throw new Error(session.error || `Amazon session failed (${session.code})`);
    }
    const provider = createStationDataProvider(env);
    const roster = await loadWorkforceRosterMap(env, { accountKey: session.accountKey });
    return reconcileCashInAssociate({
      stationCode,
      fromDate,
      toDate,
      startHourIst: Number(env.BUSINESS_DAY_START_HOUR_IST ?? '5') || 5,
      provider,
      auth: session.auth,
      workforceByTransporterId: roster.byTransporterId,
      alignDepositCycle: false,
      includeRemittanceDetails: false,
    });
  }

  const parts: CiaStationPayload[] = [];
  for (const chunk of chunks) {
    const url = new URL(`${base}/api/admin/executive/cash-in-associate`);
    url.searchParams.set('stationCode', stationCode);
    url.searchParams.set('fromDate', chunk.from);
    url.searchParams.set('toDate', chunk.to);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-admin-key': adminKey,
        Accept: 'application/json',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      const htmlish = /^\s*</.test(text) || /Worker exceeded resource limits/i.test(text);
      throw new Error(
        htmlish
          ? `CIA chunk ${chunk.from}→${chunk.to} hit Worker resource limits`
          : `CIA chunk ${chunk.from}→${chunk.to} failed (${response.status}): ${text.slice(0, 240)}`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`CIA chunk ${chunk.from}→${chunk.to} returned non-JSON`);
    }
    const summaryRaw = (body.summary && typeof body.summary === 'object'
      ? body.summary
      : {}) as CiaStationSummary;
    const windowRaw = (body.window && typeof body.window === 'object'
      ? body.window
      : {}) as { from?: string; to?: string };
    parts.push({
      window: {
        from: String(windowRaw.from ?? chunk.from),
        to: String(windowRaw.to ?? chunk.to),
      },
      summary: summaryRaw,
      ledger: Array.isArray(body.ledger) ? (body.ledger as CiaStationPayload['ledger']) : [],
      pendingDrivers: Array.isArray(body.pendingDrivers)
        ? (body.pendingDrivers as CiaStationPayload['pendingDrivers'])
        : [],
    });
  }

  return mergeCiaStationPayloads(parts, { from: fromDate, to: toDate });
}

async function fetchStationOnce(
  env: Env,
  stationCode: string,
  fromDate: string,
  toDate: string,
  _workforceByTransporterId: Awaited<ReturnType<typeof loadWorkforceRosterMap>>['byTransporterId'],
  options?: { includeRemittanceDetails?: boolean },
): Promise<{ payload: CiaStationPayload; accountKey: string }> {
  const accountKey = portalAccountKeyForStation(stationCode);
  // Prefer chunked self-fetch for Free-plan CPU limits. Interactive refresh and
  // ticker both use this path when PUBLIC_WORKER_URL is set.
  if (String(env.PUBLIC_WORKER_URL ?? '').trim()) {
    const payload = await reconcileViaLiveChunks(env, stationCode, fromDate, toDate);
    return { payload, accountKey };
  }

  const session = await ensureValidAmazonSession(env, {
    stationCode,
    triggeredBy: `cia-snapshot:${stationCode}`,
    notifyOnFailure: false,
  });
  if (!session.ok) {
    throw new Error(session.error || `Amazon session failed (${session.code})`);
  }

  const provider = createStationDataProvider(env);
  const startHourIst = Number(env.BUSINESS_DAY_START_HOUR_IST ?? '5') || 5;
  const payload = await reconcileCashInAssociate({
    stationCode,
    fromDate,
    toDate,
    startHourIst,
    provider,
    auth: session.auth,
    workforceByTransporterId: _workforceByTransporterId,
    includeRemittanceDetails: options?.includeRemittanceDetails ?? true,
  });
  return { payload, accountKey };
}

async function fetchStationWithRetry(
  env: Env,
  stationCode: string,
  fromDate: string,
  toDate: string,
  workforceByTransporterId: Awaited<ReturnType<typeof loadWorkforceRosterMap>>['byTransporterId'],
  options?: { includeRemittanceDetails?: boolean },
): Promise<{ ok: true; payload: CiaStationPayload; accountKey: string } | { ok: false; error: string; accountKey: string }> {
  const accountKey = portalAccountKeyForStation(stationCode);
  let lastError = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetchStationOnce(
        env,
        stationCode,
        fromDate,
        toDate,
        workforceByTransporterId,
        options,
      );
      return { ok: true, ...result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`CIA snapshot ${stationCode} attempt ${attempt + 1} failed`, err);
      if (attempt === 0) await sleep(1500);
    }
  }
  return { ok: false, error: lastError, accountKey };
}

export interface CiaTickResult {
  run: CiaSnapshotRun | null;
  processedStation: string | null;
  done: boolean;
}

/**
 * Process exactly one unfinished station of the active running run.
 * Selection is based on missing/stale snapshots (not a fragile index alone),
 * so overlapping cron + continue ticks cannot skip stations when a Worker dies
 * mid-fetch. Counters are always recounted from finished snapshots.
 */
export async function processCiaSnapshotTick(env: Env, runId?: string): Promise<CiaTickResult> {
  const store = createCiaSnapshotStore(env);
  const run = runId ? await store.getRun(runId) : await store.getActiveRunningRun();
  if (!run || run.status !== 'running') {
    return { run: run ?? null, processedStation: null, done: true };
  }

  const stations = stationList();
  const snapshots = await store.listStationSnapshots(run.id);
  const byCode = new Map(snapshots.map((s) => [s.stationCode, s]));

  const nextStation =
    stations.find((code) => {
      const snap = byCode.get(code);
      if (!snap) return true;
      return !isFinishedSnapshot(snap.status, snap.error);
    }) ?? null;

  if (!nextStation) {
    await finalizeFromSnapshots(env, run.id, stations.length);
    return { run: await store.getRun(run.id), processedStation: null, done: true };
  }

  const accountKey = portalAccountKeyForStation(nextStation);
  const claimed = await store.tryClaimStation({
    runId: run.id,
    stationCode: nextStation,
    accountKey,
    windowFrom: run.windowFrom,
    windowTo: run.windowTo,
  });
  if (!claimed) {
    // Another tick owns this station (or just finished it). Don't process two at once.
    return { run, processedStation: null, done: false };
  }

  const roster = await loadWorkforceRosterMap(env);
  const result = await fetchStationWithRetry(
    env,
    nextStation,
    run.windowFrom,
    run.windowTo,
    roster.byTransporterId,
  );

  if (result.ok) {
    await store.upsertStationSnapshot({
      runId: run.id,
      stationCode: nextStation,
      accountKey: result.accountKey,
      status: 'ok',
      summary: result.payload.summary,
      payload: result.payload,
    });
  } else {
    const payload = emptyPayload(run.windowFrom, run.windowTo);
    await store.upsertStationSnapshot({
      runId: run.id,
      stationCode: nextStation,
      accountKey: result.accountKey,
      status: 'error',
      error: result.error,
      summary: payload.summary,
      payload,
    });
  }

  const counters = await store.syncRunCountersFromSnapshots(run.id);
  const done =
    counters.finishedCount >= stations.length && counters.inFlightCount === 0;
  if (done) {
    await finalizeFromSnapshots(env, run.id, stations.length);
  }

  return {
    run: await store.getRun(run.id),
    processedStation: nextStation,
    done,
  };
}

async function finalizeFromSnapshots(
  env: Env,
  runId: string,
  stationsTotal: number,
): Promise<void> {
  const store = createCiaSnapshotStore(env);
  const counters = await store.syncRunCountersFromSnapshots(runId);
  if (counters.inFlightCount > 0) return;
  if (counters.finishedCount < stationsTotal) return;

  const status =
    counters.stationsOk === 0
      ? 'failed'
      : counters.stationsFailed > 0 || counters.stationsOk < stationsTotal
        ? 'completed_with_errors'
        : 'completed';

  await store.finalizeRun({
    runId,
    status,
    stationsOk: counters.stationsOk,
    stationsFailed: counters.stationsFailed,
    error:
      counters.stationsFailed > 0
        ? `${counters.stationsFailed} station(s) failed`
        : counters.stationsOk < stationsTotal
          ? `Only ${counters.stationsOk}/${stationsTotal} stations finished`
          : null,
  });
}

/**
 * Start a new daily snapshot run (or resume a same-day running one).
 * A running run from an older day is finalized as failed and superseded.
 * New runs force-sync the workforce roster (ACTIVE+INACTIVE+OFFBOARDED) once;
 * station processing happens on subsequent ticker-cron invocations.
 */
export async function startCiaSnapshotRun(
  env: Env,
): Promise<{ run: CiaSnapshotRun; resumed: boolean }> {
  const store = createCiaSnapshotStore(env);
  const window = getCiaAnalysisWindow();
  const existing = await store.getActiveRunningRun();
  if (existing) {
    if (existing.asOfDate === window.asOfDate) {
      // Heal counters / pick up any stations skipped by a killed tick.
      const counters = await store.syncRunCountersFromSnapshots(existing.id);
      if (counters.finishedCount >= stationList().length && counters.inFlightCount === 0) {
        await finalizeFromSnapshots(env, existing.id, stationList().length);
      }
      return { run: (await store.getRun(existing.id)) ?? existing, resumed: true };
    }
    await store.finalizeRun({
      runId: existing.id,
      status: 'failed',
      stationsOk: existing.stationsOk,
      stationsFailed: existing.stationsFailed,
      error: 'Superseded by a newer run',
    });
  }

  await loadWorkforceRosterMap(env, { forceRefresh: true }).catch((err) => {
    console.error('CIA run roster sync failed (continuing with cache)', err);
  });

  const stations = stationList();
  const run = await store.createRun({
    asOfDate: window.asOfDate,
    windowFrom: window.fromDate,
    windowTo: window.toDate,
    stationsTotal: stations.length,
  });
  return { run, resumed: false };
}

/**
 * Persist a BFF-merged CIA payload for one station (no Amazon calls).
 * Used when Ops Pulse refreshes via live-range chunks to avoid Error 1102.
 */
export async function saveCiaStationPayload(
  env: Env,
  stationCode: string,
  payload: CiaStationPayload,
): Promise<{ runId: string; snapshotStatus: 'ok' | 'error'; error?: string }> {
  const code = stationCode.trim().toUpperCase();
  if (!ALLOWED_STATIONS.has(code)) {
    throw new Error(`Station ${code} is not allowed`);
  }

  const store = createCiaSnapshotStore(env);
  const window = getCiaAnalysisWindow();
  let run = await store.getLatestReadableRun();
  if (!run || run.asOfDate !== window.asOfDate) {
    const running = await store.getActiveRunningRun();
    run = running && running.asOfDate === window.asOfDate ? running : null;
  }
  let createdOneOff = false;
  if (!run) {
    run = await store.createRun({
      asOfDate: window.asOfDate,
      windowFrom: window.fromDate,
      windowTo: window.toDate,
      stationsTotal: 1,
    });
    createdOneOff = true;
  }

  const accountKey = portalAccountKeyForStation(code);
  const normalized: CiaStationPayload = {
    window: {
      from: payload.window?.from || run.windowFrom,
      to: payload.window?.to || run.windowTo,
    },
    summary: payload.summary,
    ledger: Array.isArray(payload.ledger) ? payload.ledger : [],
    pendingDrivers: Array.isArray(payload.pendingDrivers) ? payload.pendingDrivers : [],
  };

  await store.upsertStationSnapshot({
    runId: run.id,
    stationCode: code,
    accountKey,
    status: 'ok',
    summary: normalized.summary,
    payload: normalized,
  });

  if (createdOneOff) {
    await store.finalizeRun({
      runId: run.id,
      status: 'completed',
      stationsOk: 1,
      stationsFailed: 0,
    });
  } else if (run.status === 'running') {
    const counters = await store.syncRunCountersFromSnapshots(run.id);
    if (counters.finishedCount >= stationList().length && counters.inFlightCount === 0) {
      await finalizeFromSnapshots(env, run.id, stationList().length);
    }
  }

  return { runId: run.id, snapshotStatus: 'ok' };
}

/**
 * Re-fetch a single station. Attaches to today's readable run when present
 * (immediately visible via GET), else today's running run, else a one-off run.
 */
export async function refreshCiaStation(
  env: Env,
  stationCode: string,
): Promise<{ runId: string; snapshotStatus: 'ok' | 'error'; error?: string }> {
  const code = stationCode.trim().toUpperCase();
  if (!ALLOWED_STATIONS.has(code)) {
    throw new Error(`Station ${code} is not allowed`);
  }

  const store = createCiaSnapshotStore(env);
  const window = getCiaAnalysisWindow();
  let run = await store.getLatestReadableRun();
  if (!run || run.asOfDate !== window.asOfDate) {
    const running = await store.getActiveRunningRun();
    run = running && running.asOfDate === window.asOfDate ? running : null;
  }
  let createdOneOff = false;
  if (!run) {
    run = await store.createRun({
      asOfDate: window.asOfDate,
      windowFrom: window.fromDate,
      windowTo: window.toDate,
      stationsTotal: 1,
    });
    createdOneOff = true;
  }

  const roster = await loadWorkforceRosterMap(env);
  // Chunked via PUBLIC_WORKER_URL when set (fresh CPU per live-range chunk).
  const result = await fetchStationWithRetry(
    env,
    code,
    run.windowFrom,
    run.windowTo,
    roster.byTransporterId,
    { includeRemittanceDetails: false },
  );

  if (result.ok) {
    await store.upsertStationSnapshot({
      runId: run.id,
      stationCode: code,
      accountKey: result.accountKey,
      status: 'ok',
      summary: result.payload.summary,
      payload: result.payload,
    });
    if (createdOneOff) {
      await store.finalizeRun({
        runId: run.id,
        status: 'completed',
        stationsOk: 1,
        stationsFailed: 0,
      });
    } else if (run.status === 'running') {
      const counters = await store.syncRunCountersFromSnapshots(run.id);
      if (counters.finishedCount >= stationList().length && counters.inFlightCount === 0) {
        await finalizeFromSnapshots(env, run.id, stationList().length);
      }
    }
    return { runId: run.id, snapshotStatus: 'ok' };
  }

  const payload = emptyPayload(run.windowFrom, run.windowTo);
  await store.upsertStationSnapshot({
    runId: run.id,
    stationCode: code,
    accountKey: result.accountKey,
    status: 'error',
    error: result.error,
    summary: payload.summary,
    payload,
  });
  if (createdOneOff) {
    await store.finalizeRun({
      runId: run.id,
      status: 'failed',
      stationsOk: 0,
      stationsFailed: 1,
      error: result.error,
    });
  } else if (run.status === 'running') {
    await store.syncRunCountersFromSnapshots(run.id);
  }
  return { runId: run.id, snapshotStatus: 'error', error: result.error };
}

/** Daily cron (06:00 IST): start/resume the run; ticks do the station work. */
export async function ciaDailyCron(env: Env): Promise<CiaSnapshotRun> {
  const { run } = await startCiaSnapshotRun(env);
  return run;
}

/** Ticker cron (every 3 min): advance the active run by one station. */
export async function ciaTickerCron(env: Env): Promise<CiaTickResult> {
  return processCiaSnapshotTick(env);
}
