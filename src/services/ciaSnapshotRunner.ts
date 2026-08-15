import type { Env, CiaStationPayload, CiaStationSummary, CiaSnapshotRun, CiaStationSnapshot } from '../types';
import {
  ALLOWED_STATIONS,
  CIA_CHUNK_PENDING_MARKER,
  CIA_PROCESSING_MARKER,
  CIA_PROCESSING_STALE_MS,
  CIA_RETRY_PENDING_MARKER,
  CIA_REFRESH_CHUNK_DAYS,
  portalAccountKeyForStation,
} from '../config';
import { createCiaSnapshotStore } from '../store/factory';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { loadWorkforceRosterMap } from './workforceRoster';
import { getCiaAnalysisWindow, mergeCiaStationPayloads, reconcileCashInAssociate, splitYmdRange } from './cashInAssociate';

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

function isRetryPendingSnapshot(status: string, error: string | null | undefined): boolean {
  return status === 'error' && error === CIA_RETRY_PENDING_MARKER;
}

function isChunkPendingSnapshot(status: string, error: string | null | undefined): boolean {
  return status === 'error' && error === CIA_CHUNK_PENDING_MARKER;
}

function isProcessingSnapshot(status: string, error: string | null | undefined): boolean {
  return status === 'error' && error === CIA_PROCESSING_MARKER;
}

function isStaleFetchedAt(fetchedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(fetchedAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts >= CIA_PROCESSING_STALE_MS;
}

function readChunkProgress(payload: CiaStationPayload | undefined): { nextIndex: number; parts: CiaStationPayload[] } {
  const raw = payload?.chunkProgress;
  const parts = Array.isArray(raw?.parts) ? raw.parts : [];
  const nextIndex = Number(raw?.nextIndex ?? parts.length) || 0;
  return { nextIndex, parts };
}

function payloadWithProgress(
  fromDate: string,
  toDate: string,
  nextIndex: number,
  parts: CiaStationPayload[],
): CiaStationPayload {
  const base = emptyPayload(fromDate, toDate);
  return { ...base, chunkProgress: { nextIndex, parts } };
}

/**
 * One 7-day CIA window in this isolate (no nested Worker HTTP).
 * Nested self-fetch via PUBLIC_WORKER_URL hits Cloudflare 1042/1102 on cron.
 */
async function reconcileOneChunkInProcess(
  env: Env,
  stationCode: string,
  fromDate: string,
  toDate: string,
  workforceByTransporterId: Awaited<ReturnType<typeof loadWorkforceRosterMap>>['byTransporterId'],
): Promise<CiaStationPayload> {
  const session = await ensureValidAmazonSession(env, {
    stationCode,
    triggeredBy: `cia-chunk:${stationCode}:${fromDate}`,
    notifyOnFailure: false,
  });
  if (!session.ok) {
    throw new Error(session.error || `Amazon session failed (${session.code})`);
  }
  const provider = createStationDataProvider(env);
  return reconcileCashInAssociate({
    stationCode,
    fromDate,
    toDate,
    startHourIst: Number(env.BUSINESS_DAY_START_HOUR_IST ?? '5') || 5,
    provider,
    auth: session.auth,
    workforceByTransporterId,
    alignDepositCycle: false,
    includeRemittanceDetails: false,
  });
}

async function fetchStationOnce(
  env: Env,
  stationCode: string,
  fromDate: string,
  toDate: string,
  workforceByTransporterId: Awaited<ReturnType<typeof loadWorkforceRosterMap>>['byTransporterId'],
  options?: { includeRemittanceDetails?: boolean },
): Promise<{ payload: CiaStationPayload; accountKey: string }> {
  const accountKey = portalAccountKeyForStation(stationCode);
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
    workforceByTransporterId,
    includeRemittanceDetails: options?.includeRemittanceDetails ?? false,
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

export interface CiaNextStationResult {
  run: CiaSnapshotRun | null;
  stationCode: string | null;
  done: boolean;
}

type SnapshotByCode = Map<string, CiaStationSnapshot>;

/** Cron: finish the current station's remaining weeks before starting another. */
function pickNextStationForCron(stations: string[], byCode: SnapshotByCode): string | null {
  return (
    stations.find((code) => {
      const snap = byCode.get(code);
      return Boolean(snap && isChunkPendingSnapshot(snap.status, snap.error));
    })
    ?? stations.find((code) => !byCode.get(code))
    ?? stations.find((code) => {
      const snap = byCode.get(code);
      return Boolean(snap && isRetryPendingSnapshot(snap.status, snap.error));
    })
    ?? stations.find((code) => {
      const snap = byCode.get(code);
      return Boolean(
        snap
        && isProcessingSnapshot(snap.status, snap.error)
        && isStaleFetchedAt(snap.fetchedAt),
      );
    })
    ?? null
  );
}

/**
 * BFF: take a station the cron is not currently fetching.
 * Skip only a fresh in-flight PROCESSING claim. Chunk/retry markers are
 * unfinished work and must be drained by the same path as Update numbers.
 */
function pickNextStationForBff(stations: string[], byCode: SnapshotByCode): string | null {
  return (
    stations.find((code) => !byCode.get(code))
    ?? stations.find((code) => {
      const snap = byCode.get(code);
      return Boolean(
        snap
        && (
          isRetryPendingSnapshot(snap.status, snap.error)
          || isChunkPendingSnapshot(snap.status, snap.error)
        ),
      );
    })
    ?? stations.find((code) => {
      const snap = byCode.get(code);
      return Boolean(
        snap
        && isProcessingSnapshot(snap.status, snap.error)
        && isStaleFetchedAt(snap.fetchedAt),
      );
    })
    ?? null
  );
}

function hasUnfinishedStationWork(stations: string[], byCode: SnapshotByCode): boolean {
  return stations.some((code) => {
    const snap = byCode.get(code);
    if (!snap) return true;
    if (isRetryPendingSnapshot(snap.status, snap.error)) return true;
    if (isChunkPendingSnapshot(snap.status, snap.error)) return true;
    if (isProcessingSnapshot(snap.status, snap.error) && !isStaleFetchedAt(snap.fetchedAt)) return true;
    return false;
  });
}
/**
 * Return the next station for Ops Pulse BFF (no Amazon fetch).
 * Pass claim=true so the UI owns the station before chunked refresh;
 * cron will not steal it into a retry marker.
 */
export async function peekNextCiaStation(
  env: Env,
  runId?: string,
  options?: { claim?: boolean },
): Promise<CiaNextStationResult> {
  const store = createCiaSnapshotStore(env);
  const run = runId ? await store.getRun(runId) : await store.getActiveRunningRun();
  if (!run || run.status !== 'running') {
    return { run: run ?? null, stationCode: null, done: true };
  }

  const stations = stationList();
  const snapshots = await store.listStationSnapshots(run.id);
  const byCode = new Map(snapshots.map((s) => [s.stationCode, s]));
  const nextStation = pickNextStationForBff(stations, byCode);

  if (!nextStation) {
    const unfinished = hasUnfinishedStationWork(stations, byCode);
    if (!unfinished) {
      await finalizeFromSnapshots(env, run.id, stations.length);
    }
    return { run: await store.getRun(run.id), stationCode: null, done: !unfinished };
  }

  if (options?.claim) {
    const claimed = await store.tryClaimStation({
      runId: run.id,
      stationCode: nextStation,
      accountKey: portalAccountKeyForStation(nextStation),
      windowFrom: run.windowFrom,
      windowTo: run.windowTo,
    });
    if (!claimed) {
      return { run, stationCode: null, done: false };
    }
  }

  return { run, stationCode: nextStation, done: false };
}

/**
 * Keep a PROCESSING claim alive while a long chunked refresh is still running.
 */
export async function touchCiaStationClaim(
  env: Env,
  args: { runId?: string; stationCode: string },
): Promise<{ touched: boolean; run: CiaSnapshotRun | null }> {
  const store = createCiaSnapshotStore(env);
  const run = args.runId ? await store.getRun(args.runId) : await store.getActiveRunningRun();
  if (!run || run.status !== 'running') {
    return { touched: false, run: run ?? null };
  }
  const code = args.stationCode.trim().toUpperCase();
  const touched = await store.touchProcessingClaim(run.id, code);
  return { touched, run };
}

/**
 * BFF hit Cloudflare 1102 / abort after claiming a station. Release the
 * in-flight marker so the next continue can retry immediately instead of
 * waiting for the stale timeout.
 */
export async function releaseCiaStationClaim(
  env: Env,
  args: { runId?: string; stationCode: string },
): Promise<{ released: boolean; run: CiaSnapshotRun | null }> {
  const store = createCiaSnapshotStore(env);
  const run = args.runId ? await store.getRun(args.runId) : await store.getActiveRunningRun();
  if (!run || run.status !== 'running') {
    return { released: false, run: run ?? null };
  }
  const code = args.stationCode.trim().toUpperCase();
  const snap = await store.getStationSnapshot(run.id, code);
  if (!snap || !isProcessingSnapshot(snap.status, snap.error)) {
    return { released: false, run };
  }
  await store.upsertStationSnapshot({
    runId: run.id,
    stationCode: code,
    accountKey: snap.accountKey,
    status: 'error',
    error: CIA_RETRY_PENDING_MARKER,
    summary: snap.summary,
    payload: snap.payload,
  });
  await store.syncRunCountersFromSnapshots(run.id);
  return { released: true, run: await store.getRun(run.id) };
}

/**
 * Cron tick: fetch exactly one 7-day chunk in this isolate, then stop.
 * After all weeks for a station are in, merge and mark ok.
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
  const nextStation = pickNextStationForCron(stations, byCode);

  if (!nextStation) {
    const unfinished = hasUnfinishedStationWork(stations, byCode);
    if (!unfinished) {
      await finalizeFromSnapshots(env, run.id, stations.length);
    }
    return { run: await store.getRun(run.id), processedStation: null, done: !unfinished };
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
    return { run, processedStation: null, done: false };
  }

  const claimedSnap = await store.getStationSnapshot(run.id, nextStation);
  const chunks = splitYmdRange(run.windowFrom, run.windowTo, CIA_REFRESH_CHUNK_DAYS);
  const progress = readChunkProgress(claimedSnap?.payload);
  const index = Math.min(progress.nextIndex, chunks.length);
  const parts = progress.parts.slice(0, index);

  if (chunks.length === 0 || index >= chunks.length) {
    if (parts.length > 0) {
      const merged = mergeCiaStationPayloads(parts, { from: run.windowFrom, to: run.windowTo });
      await store.upsertStationSnapshot({
        runId: run.id,
        stationCode: nextStation,
        accountKey,
        status: 'ok',
        summary: merged.summary,
        payload: merged,
      });
    }
    const counters = await store.syncRunCountersFromSnapshots(run.id);
    const done = counters.finishedCount >= stations.length && counters.inFlightCount === 0;
    if (done) await finalizeFromSnapshots(env, run.id, stations.length);
    return { run: await store.getRun(run.id), processedStation: nextStation, done };
  }

  const chunk = chunks[index];
  if (!chunk) {
    const counters = await store.syncRunCountersFromSnapshots(run.id);
    const done = counters.finishedCount >= stations.length && counters.inFlightCount === 0;
    if (done) await finalizeFromSnapshots(env, run.id, stations.length);
    return { run: await store.getRun(run.id), processedStation: nextStation, done };
  }
  const roster = await loadWorkforceRosterMap(env);

  try {
    const part = await reconcileOneChunkInProcess(
      env,
      nextStation,
      chunk.from,
      chunk.to,
      roster.byTransporterId,
    );
    const latestSnap = await store.getStationSnapshot(run.id, nextStation);
    if (latestSnap?.status === 'ok') {
      const counters = await store.syncRunCountersFromSnapshots(run.id);
      const done = counters.finishedCount >= stations.length && counters.inFlightCount === 0;
      if (done) await finalizeFromSnapshots(env, run.id, stations.length);
      return { run: await store.getRun(run.id), processedStation: nextStation, done };
    }
    const nextParts = [...parts, part];
    const nextIndex = index + 1;
    if (nextIndex >= chunks.length) {
      const merged = mergeCiaStationPayloads(nextParts, {
        from: run.windowFrom,
        to: run.windowTo,
      });
      await store.upsertStationSnapshot({
        runId: run.id,
        stationCode: nextStation,
        accountKey,
        status: 'ok',
        summary: merged.summary,
        payload: merged,
      });
    } else {
      const pending = payloadWithProgress(run.windowFrom, run.windowTo, nextIndex, nextParts);
      await store.upsertStationSnapshot({
        runId: run.id,
        stationCode: nextStation,
        accountKey,
        status: 'error',
        error: CIA_CHUNK_PENDING_MARKER,
        summary: pending.summary,
        payload: pending,
      });
    }
  } catch (err) {
    const latestSnap = await store.getStationSnapshot(run.id, nextStation);
    if (latestSnap?.status === 'ok') {
      const counters = await store.syncRunCountersFromSnapshots(run.id);
      const done = counters.finishedCount >= stations.length && counters.inFlightCount === 0;
      if (done) await finalizeFromSnapshots(env, run.id, stations.length);
      return { run: await store.getRun(run.id), processedStation: nextStation, done };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`CIA chunk ${nextStation} ${chunk.from}->${chunk.to} failed`, err);
    const wasRetry = Boolean(
      claimedSnap && isRetryPendingSnapshot(claimedSnap.status, claimedSnap.error),
    );
    const pending = payloadWithProgress(run.windowFrom, run.windowTo, index, parts);
    await store.upsertStationSnapshot({
      runId: run.id,
      stationCode: nextStation,
      accountKey,
      status: 'error',
      error: wasRetry ? message : CIA_RETRY_PENDING_MARKER,
      summary: pending.summary,
      payload: pending,
    });
  }

  const counters = await store.syncRunCountersFromSnapshots(run.id);
  const done = counters.finishedCount >= stations.length && counters.inFlightCount === 0;
  if (done) await finalizeFromSnapshots(env, run.id, stations.length);

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
 * Pass `forceNew: true` for manual "Refresh all" so a stuck same-day run
 * (retry queue / failed stations) is superseded and progress resets to 0/N.
 * New runs force-sync the workforce roster (ACTIVE+INACTIVE+OFFBOARDED) once;
 * station processing happens on subsequent ticker-cron invocations.
 */
export async function startCiaSnapshotRun(
  env: Env,
  options?: { forceNew?: boolean },
): Promise<{ run: CiaSnapshotRun; resumed: boolean }> {
  const store = createCiaSnapshotStore(env);
  const window = getCiaAnalysisWindow();
  const forceNew = Boolean(options?.forceNew);
  const existing = await store.getActiveRunningRun();
  if (existing) {
    if (existing.asOfDate === window.asOfDate) {
      const counters = await store.syncRunCountersFromSnapshots(existing.id);
      const total = stationList().length;
      const complete = counters.finishedCount >= total && counters.inFlightCount === 0;
      if (complete) {
        await finalizeFromSnapshots(env, existing.id, total);
        if (!forceNew) {
          return { run: (await store.getRun(existing.id)) ?? existing, resumed: true };
        }
      } else {
        // Never discard a same-day in-progress run (e.g. 37 ok, 1 in flight).
        return { run: (await store.getRun(existing.id)) ?? existing, resumed: true };
      }
    }
    const counters = await store.syncRunCountersFromSnapshots(existing.id);
    await store.finalizeRun({
      runId: existing.id,
      status: 'failed',
      stationsOk: counters.stationsOk,
      stationsFailed: counters.stationsFailed + counters.retryQueuedCount + counters.processingCount,
      error: forceNew
        ? 'Superseded by manual Refresh all'
        : 'Superseded by a newer run',
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
 * Attach a one-station save to an existing network run. Prefer today's
 * running Refresh-all, else the completed list the Stations page shows.
 * Never start a new 38-station running run from row Refresh.
 */
async function pickRunForSingleStationSave(
  store: ReturnType<typeof createCiaSnapshotStore>,
  window: { asOfDate: string; fromDate: string; toDate: string },
  fullCount: number,
): Promise<CiaSnapshotRun> {
  const running = await store.getActiveRunningRun();
  if (running && running.asOfDate === window.asOfDate) {
    return running;
  }

  const resolved = await store.resolveNetworkRun(fullCount);
  if (resolved.progress && resolved.progress.asOfDate === window.asOfDate) {
    return resolved.progress;
  }
  if (resolved.run) {
    return resolved.run;
  }

  const best = await store.getBestCompletedNetworkRun(Math.min(2, fullCount));
  if (best) return best;

  return store.createRun({
    asOfDate: window.asOfDate,
    windowFrom: window.fromDate,
    windowTo: window.toDate,
    stationsTotal: fullCount,
  });
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
  const fullCount = stationList().length;
  const run = await pickRunForSingleStationSave(store, window, fullCount);

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

  const counters = await store.syncRunCountersFromSnapshots(run.id);
  if (counters.finishedCount >= stationList().length && counters.inFlightCount === 0) {
    await finalizeFromSnapshots(env, run.id, stationList().length);
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
  const fullCount = stationList().length;
  const run = await pickRunForSingleStationSave(store, window, fullCount);

  const roster = await loadWorkforceRosterMap(env);
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
    const counters = await store.syncRunCountersFromSnapshots(run.id);
    if (counters.finishedCount >= stationList().length && counters.inFlightCount === 0) {
      await finalizeFromSnapshots(env, run.id, stationList().length);
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
  await store.syncRunCountersFromSnapshots(run.id);
  return { runId: run.id, snapshotStatus: 'error', error: result.error };
}

/** Daily cron (06:00 IST): start/resume the run, then fetch one station via Ops Pulse BFF. */
export async function ciaDailyCron(env: Env): Promise<CiaSnapshotRun> {
  const { run } = await startCiaSnapshotRun(env);
  const viaPulse = await continueViaOpsPulse(env, run.id);
  if (viaPulse.handled) {
    console.log(
      `CIA daily run ${run.id} via Ops Pulse station=${viaPulse.processedStation ?? 'none'} done=${viaPulse.done}`,
    );
    return (await createCiaSnapshotStore(env).getRun(run.id)) ?? run;
  }
  try {
    const tick = await processCiaSnapshotTick(env, run.id);
    console.log(
      `CIA daily run ${run.id} station=${tick.processedStation ?? 'none'} done=${tick.done}`,
    );
    return (await createCiaSnapshotStore(env).getRun(run.id)) ?? run;
  } catch (err) {
    console.error('CIA daily first-station kick failed', err);
    return run;
  }
}

/** Ticker: one full station via Ops Pulse (same as Update numbers), else one 7-day chunk. */
export async function ciaTickerCron(env: Env): Promise<CiaTickResult> {
  const viaPulse = await continueViaOpsPulse(env);
  if (viaPulse.handled && (viaPulse.processedStation || viaPulse.done)) {
    const run = viaPulse.run ?? (await createCiaSnapshotStore(env).getActiveRunningRun());
    if (viaPulse.processedStation) {
      console.log(`CIA tick via Ops Pulse station=${viaPulse.processedStation} done=${viaPulse.done}`);
    }
    return { run, processedStation: viaPulse.processedStation, done: viaPulse.done };
  }
  const tick = await processCiaSnapshotTick(env);
  if (tick.processedStation) {
    console.log(`CIA tick station=${tick.processedStation} done=${tick.done}`);
  } else if (tick.run?.status === 'running' && !tick.done) {
    console.warn(`CIA ticker idle for run ${tick.run.id}`);
  }
  return tick;
}

async function continueViaOpsPulse(
  env: Env,
  runId?: string,
): Promise<{
  handled: boolean;
  processedStation: string | null;
  done: boolean;
  run: CiaSnapshotRun | null;
}> {
  const base = String(env.OPS_PULSE_URL ?? '').trim().replace(/\/$/, '');
  const key = String(env.ADMIN_API_KEY ?? '').trim();
  if (!base || !key) {
    return { handled: false, processedStation: null, done: false, run: null };
  }
  try {
    const response = await fetch(`${base}/api/internal/cia-snapshot/continue`, {
      method: 'POST',
      headers: {
        'x-admin-key': key,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(runId ? { runId } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      console.error(`CIA Ops Pulse continue failed (${response.status}): ${text.slice(0, 240)}`);
      return { handled: false, processedStation: null, done: false, run: null };
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { handled: true, processedStation: null, done: false, run: null };
    }
    const runRaw = body.run && typeof body.run === 'object' ? (body.run as { id?: string }) : null;
    const store = createCiaSnapshotStore(env);
    const run = runRaw?.id ? await store.getRun(String(runRaw.id)) : await store.getActiveRunningRun();
    return {
      handled: true,
      processedStation: body.processedStation == null ? null : String(body.processedStation),
      done: Boolean(body.done),
      run,
    };
  } catch (err) {
    console.error('CIA Ops Pulse continue request failed', err);
    return { handled: false, processedStation: null, done: false, run: null };
  }
}
