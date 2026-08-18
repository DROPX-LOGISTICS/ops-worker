import type { Context } from 'hono';
import type { Env, CiaStationSummary, CiaStationPayload, CiaSnapshotRun, CiaStationSnapshot } from '../types';
import {
  ALLOWED_STATIONS,
  API_CACHE_TTL_MS,
  CIA_CHUNK_PENDING_MARKER,
  CIA_LIVE_RANGE_CACHE_TTL_MS,
  CIA_PROCESSING_MARKER,
  CIA_RETRY_PENDING_MARKER,
} from '../config';
import { createCiaSnapshotStore, createApiResponseCacheStore } from '../store/factory';
import { isCiaSchemaReady } from './dbDiag';
import { ValidationInputError } from '../errors';
import { round2 } from '../utils/number';
import { addDaysYmd, daysBetweenYmd, todayIstYmd } from '../utils/dateRange';
import { cachedJson, invalidateCacheAll } from '../utils/ttlCache';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { loadWorkforceRosterMap } from '../services/workforceRoster';
import { reconcileCashInAssociate } from '../services/cashInAssociate';
import {
  peekNextCiaStation,
  processCiaSnapshotTick,
  refreshCiaStation,
  releaseCiaStationClaim,
  saveCiaStationPayload,
  startCiaSnapshotRun,
  touchCiaStationClaim,
} from '../services/ciaSnapshotRunner';
import { readCiaTickerState, touchCiaFrontendLease } from '../services/ciaTickerState';

/**
 * An empty table and an absent table both surface as `null` from the store, so
 * probe the schema before blaming the cron. Without this the dashboard tells
 * operators to wait for a 06:00 run that cannot possibly write anything.
 */
async function noSnapshotBody(env: Env, message: string) {
  if (await isCiaSchemaReady(env)) {
    return { status: 'not_found', code: 'NO_CIA_SNAPSHOT', message };
  }
  return {
    status: 'not_found',
    code: 'CIA_SCHEMA_MISSING',
    message:
      'Cash In Associate tables are missing from the Supabase project this worker points at. '
      + 'Run sql/company-cutover.sql in that project, then refresh. '
      + 'GET /api/admin/diag/db shows which tables are absent.',
  };
}

async function buildRefreshProgress(env: Env, run: CiaSnapshotRun | null) {
  if (!run) return null;
  const store = createCiaSnapshotStore(env);
  const counters = await store.syncRunCountersFromSnapshots(run.id);
  const attempted =
    counters.stationsOk
    + counters.stationsFailed
    + counters.retryQueuedCount
    + counters.processingCount;
  return {
    id: run.id,
    status: run.status,
    asOfDate: run.asOfDate,
    windowFrom: run.windowFrom,
    windowTo: run.windowTo,
    startedAt: run.startedAt,
    stationsTotal: Math.max(run.stationsTotal, ALLOWED_STATIONS.size),
    stationsOk: attempted,
    stationsSucceeded: counters.stationsOk,
    stationsFailed: counters.stationsFailed,
    stationsRetryQueued: counters.retryQueuedCount,
    stationsProcessing: counters.processingCount,
  };
}

function sumSummaries(summaries: CiaStationSummary[]): CiaStationSummary {
  const ciaTotal = round2(summaries.reduce((s, x) => s + (x.ciaTotal ?? 0), 0));
  const cashAtStationTotal = round2(
    summaries.reduce((s, x) => s + (x.cashAtStationTotal ?? 0), 0),
  );
  const ageingTotal = round2(
    summaries.reduce((s, x) => s + (x.ageingTotal ?? x.ciaTotal ?? 0), 0),
  );
  const depositedTotal = round2(summaries.reduce((s, x) => s + x.depositedTotal, 0));
  const cashDifference = round2(ageingTotal - depositedTotal);
  const alignedDates = summaries.map((x) => x.alignedFromDate).filter(Boolean).sort();
  return {
    ciaTotal,
    cashAtStationTotal,
    ageingTotal,
    depositedTotal,
    pendingLiability: round2(summaries.reduce((s, x) => s + x.pendingLiability, 0)),
    clearedInWindow: round2(summaries.reduce((s, x) => s + x.clearedInWindow, 0)),
    cashDifference,
    difference: cashDifference,
    shipmentCount: summaries.reduce((s, x) => s + x.shipmentCount, 0),
    pendingDriverCount: summaries.reduce((s, x) => s + x.pendingDriverCount, 0),
    limitedByRemittanceWindow: summaries.some((x) => x.limitedByRemittanceWindow),
    alignedFromDate: alignedDates[0] ?? '',
  };
}

type CiaReadResult =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'not_found'; body: Record<string, unknown> };

function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isUsableStationSnap(snap: CiaStationSnapshot | null): snap is CiaStationSnapshot {
  if (!snap) return false;
  if (snap.error === CIA_PROCESSING_MARKER || snap.error === CIA_RETRY_PENDING_MARKER || snap.error === CIA_CHUNK_PENDING_MARKER) return false;
  return true;
}

/**
 * Same overlay as the network list: in-progress refresh snapshots win over the
 * older completed base run, so station drill-down matches the Stations table.
 */
async function resolveStationRead(
  store: ReturnType<typeof createCiaSnapshotStore>,
  stationCode: string,
  asOfDateQuery: string,
): Promise<{ run: CiaSnapshotRun | null; snap: CiaStationSnapshot | null }> {
  if (asOfDateQuery) {
    const run = await store.getReadableRunByAsOfDate(asOfDateQuery);
    const snap = run ? await store.getStationSnapshot(run.id, stationCode) : null;
    return { run, snap: isUsableStationSnap(snap) ? snap : null };
  }

  const { run, progress } = await store.resolveNetworkRun(ALLOWED_STATIONS.size);
  const progressSnap = progress
    ? await store.getStationSnapshot(progress.id, stationCode)
    : null;
  if (isUsableStationSnap(progressSnap)) {
    return { run: progress ?? run, snap: progressSnap };
  }

  const baseSnap = run ? await store.getStationSnapshot(run.id, stationCode) : null;
  if (isUsableStationSnap(baseSnap)) {
    return { run, snap: baseSnap };
  }

  const latest = await store.getLatestFinishedStationSnapshot(stationCode);
  if (latest) {
    return { run: latest.run ?? run, snap: latest.snap };
  }

  return { run, snap: null };
}

/**
 * GET /api/admin/executive/cash-in-associate?stationCode=KTUO
 * Optional `asOfDate=YYYY-MM-DD` loads that day's saved report (default: latest).
 * Serves one station from a completed snapshot (60s cached).
 */
export async function ciaStationHandler(c: Context<{ Bindings: Env }>) {
  const stationCode = (c.req.query('stationCode') ?? '').trim().toUpperCase();
  const asOfDateQuery = (c.req.query('asOfDate') ?? '').trim();
  const fromDateQuery = (c.req.query('fromDate') ?? '').trim();
  const toDateQuery = (c.req.query('toDate') ?? '').trim();
  if (!stationCode) throw new ValidationInputError('stationCode is required');
  if (!ALLOWED_STATIONS.has(stationCode)) {
    throw new ValidationInputError(`Station ${stationCode} is not allowed`);
  }
  if ((fromDateQuery && !toDateQuery) || (!fromDateQuery && toDateQuery)) {
    throw new ValidationInputError('fromDate and toDate must be provided together');
  }
  if (fromDateQuery && toDateQuery) {
    if (!isValidYmd(fromDateQuery) || !isValidYmd(toDateQuery)) {
      throw new ValidationInputError('fromDate and toDate must be YYYY-MM-DD');
    }
    if (toDateQuery < fromDateQuery) {
      throw new ValidationInputError('toDate must be on or after fromDate');
    }
    const today = todayIstYmd();
    const earliest = addDaysYmd(today, -89);
    if (fromDateQuery < earliest || toDateQuery > today) {
      throw new ValidationInputError(
        `Date range must stay between ${earliest} and ${today} (up to 90 days).`,
      );
    }
    if (daysBetweenYmd(fromDateQuery, toDateQuery) > 89) {
      throw new ValidationInputError('Date range cannot exceed 90 days');
    }
  }

  const shared = createApiResponseCacheStore(c.env);
  const isLiveRange = Boolean(fromDateQuery && toDateQuery);
  const cacheKey = isLiveRange
    ? `cia:station-live:${stationCode}:${fromDateQuery}:${toDateQuery}`
    : `cia:station:v3:${stationCode}:${asOfDateQuery || 'latest'}`;
  const { value, cacheHit } = await cachedJson<CiaReadResult>(
    cacheKey,
    isLiveRange ? CIA_LIVE_RANGE_CACHE_TTL_MS : API_CACHE_TTL_MS,
    async () => {
      const store = createCiaSnapshotStore(c.env);

      if (fromDateQuery && toDateQuery) {
        const ensured = await ensureValidAmazonSession(c.env, {
          triggeredBy: `cia-station-range:${stationCode}`,
          stationCode,
          notifyOnFailure: true,
        });
        if (!ensured.ok) {
          throw new Error(ensured.error);
        }

        const provider = createStationDataProvider(c.env);
        // Roster from Supabase cache only — do not block live range on workforce refresh.
        const workforce = await loadWorkforceRosterMap(c.env, { accountKey: ensured.accountKey });
        const payload = await reconcileCashInAssociate({
          stationCode,
          fromDate: fromDateQuery,
          toDate: toDateQuery,
          startHourIst: Number(c.env.BUSINESS_DAY_START_HOUR_IST || '5') || 5,
          provider,
          auth: ensured.auth,
          workforceByTransporterId: workforce.byTransporterId,
          alignDepositCycle: false,
          includeRemittanceDetails: false,
        });

        return {
          kind: 'ok',
          body: {
            status: 'ok',
            asOfDate: toDateQuery,
            window: { from: fromDateQuery, to: toDateQuery },
            runStatus: null,
            runId: null,
            stationCode,
            snapshotStatus: 'ok',
            error: null,
            fetchedAt: new Date().toISOString(),
            summary: payload.summary,
            ledger: payload.ledger,
            pendingDrivers: payload.pendingDrivers,
            // Skip listing 90 days of runs on the hot live path — empty is fine.
            availableReportDates: [] as string[],
            mode: 'live_range',
          },
        };
      }

      const sinceDate = addDaysYmd(todayIstYmd(), -90);
      const recentRuns = await store.listReadableRunsSince(sinceDate);
      const availableReportDates = [...new Set(recentRuns.map((r) => r.asOfDate))].sort(
        (a, b) => b.localeCompare(a),
      );

      const { run, snap } = await resolveStationRead(store, stationCode, asOfDateQuery);

      if (!snap) {
        return {
          kind: 'not_found',
          body: {
            status: 'not_found',
            code: 'STATION_NOT_IN_SNAPSHOT',
            message: asOfDateQuery
              ? `Station ${stationCode} is not in the report saved for ${asOfDateQuery}.`
              : `No saved Cash In Associate data for ${stationCode} yet. Refresh this station or wait for the network run.`,
            run: run ? { id: run.id, asOfDate: run.asOfDate, status: run.status } : null,
            availableReportDates,
          },
        };
      }

      const windowFrom = run?.windowFrom || snap.payload.window?.from || '';
      const windowTo = run?.windowTo || snap.payload.window?.to || '';
      const asOfDate = run?.asOfDate || windowTo || '';

      return {
        kind: 'ok',
        body: {
          status: 'ok',
          asOfDate,
          window: { from: windowFrom, to: windowTo },
          runStatus: run?.status ?? null,
          runId: run?.id ?? snap.runId,
          stationCode: snap.stationCode,
          snapshotStatus: snap.status,
          error: snap.error,
          fetchedAt: snap.fetchedAt,
          summary: snap.summary,
          ledger: snap.payload.ledger ?? [],
          pendingDrivers: snap.payload.pendingDrivers ?? [],
          availableReportDates,
        },
      };
    },
    shared,
  );

  return c.json({ ...value.body, cached: cacheHit }, value.kind === 'ok' ? 200 : 404);
}

/**
 * GET /api/admin/executive/cash-in-associate/network
 * Network rollup of CIA totals across stations.
 * Uses the fullest completed multi-station run as the base view; if a full
 * refresh is running, merges finished stations from progress onto that base
 * so "Refresh all" never collapses the list to one station (e.g. ERSE).
 */
export async function ciaNetworkHandler(c: Context<{ Bindings: Env }>) {
  const shared = createApiResponseCacheStore(c.env);
  const { value, cacheHit } = await cachedJson<CiaReadResult>(
    'cia:network:v6',
    API_CACHE_TTL_MS,
    async () => {
      const store = createCiaSnapshotStore(c.env);
      const { run, source, progress } = await store.resolveNetworkRun(ALLOWED_STATIONS.size);
      if (!run) {
        return {
          kind: 'not_found',
          body: await noSnapshotBody(
            c.env,
            'No Cash In Associate snapshot yet. Wait for the 06:00 IST cron or POST refresh.',
          ),
        };
      }

      const baseSnaps = await store.listFinishedStationSnapshots(run.id);
      const byCode = new Map(baseSnaps.map((s) => [s.stationCode, s]));
      if (progress && progress.id !== run.id) {
        for (const snap of await store.listFinishedStationSnapshots(progress.id)) {
          byCode.set(snap.stationCode, snap);
        }
      }
      const snaps = [...byCode.values()].sort((a, b) => a.stationCode.localeCompare(b.stationCode));
      const okSummaries = snaps.filter((s) => s.status === 'ok').map((s) => s.summary);
      const totals = sumSummaries(okSummaries);
      const stationsOk = snaps.filter((s) => s.status === 'ok').length;
      const stationsFailed = snaps.filter((s) => s.status === 'error').length;
      const progressCounters = progress
        ? await store.syncRunCountersFromSnapshots(progress.id)
        : null;
      const backgroundCron = await readCiaTickerState(c.env);
      const refreshActive = Boolean(progress && progress.status === 'running');
      // During refresh, show the target report date (yesterday IST) from the
      // in-progress run — not the older fullest completed run still backing most rows.
      const displayRun =
        refreshActive && progress!.asOfDate.localeCompare(run.asOfDate) >= 0
          ? progress!
          : run;

      return {
        kind: 'ok',
        body: {
          status: 'ok',
          asOfDate: displayRun.asOfDate,
          window: { from: displayRun.windowFrom, to: displayRun.windowTo },
          runSource: source,
          run: {
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            stationsTotal: Math.max(run.stationsTotal, ALLOWED_STATIONS.size),
            stationsOk,
            stationsFailed,
          },
          refreshProgress: progress
            ? {
                id: progress.id,
                status: progress.status,
                asOfDate: progress.asOfDate,
                windowFrom: progress.windowFrom,
                windowTo: progress.windowTo,
                startedAt: progress.startedAt,
                stationsTotal: Math.max(progress.stationsTotal, ALLOWED_STATIONS.size),
                // Count any station that has been claimed/attempted so UI does not
                // stay at 0/38 when failures are queued for end-of-run retry.
                stationsOk:
                  (progressCounters?.stationsOk ?? progress.stationsOk)
                  + (progressCounters?.stationsFailed ?? progress.stationsFailed)
                  + (progressCounters?.retryQueuedCount ?? 0)
                  + (progressCounters?.processingCount ?? 0),
                stationsSucceeded: progressCounters?.stationsOk ?? progress.stationsOk,
                stationsFailed: progressCounters?.stationsFailed ?? progress.stationsFailed,
                stationsRetryQueued: progressCounters?.retryQueuedCount ?? 0,
                stationsProcessing: progressCounters?.processingCount ?? 0,
              }
            : null,
          backgroundCron,
          totals,
          stations: snaps.map((s) => ({
            stationCode: s.stationCode,
            status: s.status,
            error: s.error,
            fetchedAt: s.fetchedAt,
            accountKey: s.accountKey,
            ...s.summary,
          })),
        },
      };
    },
    shared,
  );

  return c.json({ ...value.body, cached: cacheHit }, value.kind === 'ok' ? 200 : 404);
}

/**
 * GET /api/admin/executive/cash-in-associate/daily-ledger
 * Optional `date=YYYY-MM-DD` — day-wise Cash In Associate ledger across stations
 * from the network snapshot (expected CIA cash, deposits, pending, forwarded).
 */
export async function ciaDailyLedgerHandler(c: Context<{ Bindings: Env }>) {
  const dateQuery = (c.req.query('date') ?? '').trim();
  if (dateQuery && !isValidYmd(dateQuery)) {
    throw new ValidationInputError('date must be YYYY-MM-DD');
  }

  const shared = createApiResponseCacheStore(c.env);
  const cacheKey = `cia:daily-ledger:${dateQuery || 'all'}`;
  const { value, cacheHit } = await cachedJson<CiaReadResult>(
    cacheKey,
    API_CACHE_TTL_MS,
    async () => {
      const store = createCiaSnapshotStore(c.env);
      const { run, source, progress } = await store.resolveNetworkRun(ALLOWED_STATIONS.size);
      if (!run) {
        return {
          kind: 'not_found',
          body: await noSnapshotBody(c.env, 'No Cash In Associate snapshot yet.'),
        };
      }

      const baseSnaps = (await store.listFinishedStationSnapshots(run.id)).filter(
        (s) => s.status === 'ok',
      );
      const byCode = new Map(baseSnaps.map((s) => [s.stationCode, s]));
      if (progress && progress.id !== run.id) {
        for (const snap of await store.listFinishedStationSnapshots(progress.id)) {
          if (snap.status === 'ok') byCode.set(snap.stationCode, snap);
        }
      }
      const snaps = [...byCode.values()];

      type DayAgg = {
        date: string;
        cashWithAssociate: number;
        deposited: number;
        pending: number;
        forwarded: number;
        stationCount: number;
      };
      type StationDay = {
        stationCode: string;
        date: string;
        cashWithAssociate: number;
        deposited: number;
        pending: number;
        forwarded: number;
      };

      const byDate = new Map<string, DayAgg>();
      const stationDays: StationDay[] = [];

      for (const snap of snaps) {
        const ledger = Array.isArray(snap.payload?.ledger) ? snap.payload.ledger : [];
        for (const day of ledger) {
          const date = String(day.date ?? '').trim();
          if (!date) continue;
          if (dateQuery && date !== dateQuery) continue;

          const cashWithAssociate = round2(Number(day.expectedCashTotal ?? 0) || 0);
          const deposited = round2(Number(day.remittanceTotalCash ?? 0) || 0);
          const pending = round2(Number(day.stillPendingAmount ?? 0) || 0);
          const forwarded = round2(Number(day.forwardedAmount ?? 0) || 0);

          stationDays.push({
            stationCode: snap.stationCode,
            date,
            cashWithAssociate,
            deposited,
            pending,
            forwarded,
          });

          const agg = byDate.get(date) ?? {
            date,
            cashWithAssociate: 0,
            deposited: 0,
            pending: 0,
            forwarded: 0,
            stationCount: 0,
          };
          agg.cashWithAssociate = round2(agg.cashWithAssociate + cashWithAssociate);
          agg.deposited = round2(agg.deposited + deposited);
          agg.pending = round2(agg.pending + pending);
          agg.forwarded = round2(agg.forwarded + forwarded);
          if (cashWithAssociate > 0 || deposited > 0 || pending > 0 || forwarded > 0) {
            agg.stationCount += 1;
          }
          byDate.set(date, agg);
        }
      }

      const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
      stationDays.sort(
        (a, b) => b.date.localeCompare(a.date) || a.stationCode.localeCompare(b.stationCode),
      );

      const totals = days.reduce(
        (acc, d) => ({
          cashWithAssociate: round2(acc.cashWithAssociate + d.cashWithAssociate),
          deposited: round2(acc.deposited + d.deposited),
          pending: round2(acc.pending + d.pending),
          forwarded: round2(acc.forwarded + d.forwarded),
        }),
        { cashWithAssociate: 0, deposited: 0, pending: 0, forwarded: 0 },
      );

      return {
        kind: 'ok',
        body: {
          status: 'ok',
          asOfDate: run.asOfDate,
          window: { from: run.windowFrom, to: run.windowTo },
          selectedDate: dateQuery || null,
          runSource: source,
          run: {
            id: run.id,
            status: run.status,
            stationsTotal: Math.max(run.stationsTotal, ALLOWED_STATIONS.size),
            stationsOk: run.stationsOk,
          },
          totals,
          days,
          stationDays,
        },
      };
    },
    shared,
  );

  return c.json({ ...value.body, cached: cacheHit }, value.kind === 'ok' ? 200 : 404);
}

/**
 * POST /api/admin/executive/cash-in-associate/refresh
 * - Body `{ stationCode, precomputedPayload }` → persist a payload built by the
 *   BFF from live-range chunks (avoids Error 1102 on full-window sync).
 * - Body `{ stationCode }` → sync refresh (chunked via PUBLIC_WORKER_URL when set).
 * - Empty body → start/resume full network snapshot (ticker advances stations).
 */
export async function ciaRefreshHandler(c: Context<{ Bindings: Env }>) {
  let stationCode = (c.req.query('stationCode') ?? '').trim().toUpperCase();
  let precomputedPayload: CiaStationPayload | null = null;
  let skipFirstTick = false;
  try {
    const body = (await c.req.json()) as {
      stationCode?: string;
      precomputedPayload?: CiaStationPayload;
      skipFirstTick?: boolean;
    };
    if (body?.stationCode?.trim()) stationCode = body.stationCode.trim().toUpperCase();
    if (body?.precomputedPayload && typeof body.precomputedPayload === 'object') {
      precomputedPayload = body.precomputedPayload;
    }
    skipFirstTick = Boolean(body?.skipFirstTick);
  } catch {
    /* empty body = full run */
  }

  if (stationCode) {
    if (!ALLOWED_STATIONS.has(stationCode)) {
      throw new ValidationInputError(`Station ${stationCode} is not allowed`);
    }
    if (precomputedPayload) {
      const result = await saveCiaStationPayload(c.env, stationCode, precomputedPayload);
      await invalidateCacheAll('cia:', createApiResponseCacheStore(c.env));
      return c.json({
        status: result.snapshotStatus === 'ok' ? 'ok' : 'error',
        stationCode,
        runId: result.runId,
        snapshotStatus: result.snapshotStatus,
        error: result.error ?? null,
      });
    }
    const result = await refreshCiaStation(c.env, stationCode);
    await invalidateCacheAll('cia:', createApiResponseCacheStore(c.env));
    return c.json({
      status: result.snapshotStatus === 'ok' ? 'ok' : 'error',
      stationCode,
      runId: result.runId,
      snapshotStatus: result.snapshotStatus,
      error: result.error ?? null,
    });
  }

  // Manual Refresh all always starts a clean run so the UI resets from the
  // previous retry/fail queue (e.g. 38/38 with 0 ok) instead of resuming it.
  const { run, resumed } = await startCiaSnapshotRun(c.env, { forceNew: true });
  // Ops Pulse BFF passes skipFirstTick and refreshes the first station itself
  // via the proven chunked path (same as row Refresh). Worker-side first kick
  // often lands in retry because nested self-fetch hits CF resource limits.
  let tick: Awaited<ReturnType<typeof processCiaSnapshotTick>> | null = null;
  if (!skipFirstTick) {
    try {
      tick = await processCiaSnapshotTick(c.env, run.id);
    } catch (err) {
      console.error('CIA refresh first-station kick failed', err);
    }
  }
  await invalidateCacheAll('cia:', createApiResponseCacheStore(c.env));
  const store = createCiaSnapshotStore(c.env);
  const latest = tick?.run ?? (await store.getRun(run.id)) ?? run;
  const refreshProgress = await buildRefreshProgress(c.env, latest);
  const attempted = refreshProgress?.stationsOk ?? 0;
  const total = refreshProgress?.stationsTotal ?? Math.max(latest.stationsTotal, ALLOWED_STATIONS.size);

  return c.json({
    status: 'accepted',
    resumed,
    run: latest,
    processedStation: tick?.processedStation ?? null,
    done: tick?.done ?? false,
    refreshProgress,
    message: tick?.processedStation
      ? `Fresh snapshot run started; processed ${tick.processedStation} (${attempted}/${total}). `
        + 'Ops Pulse advances about every 15 seconds while the page is open; cron is every 3 minutes.'
      : skipFirstTick
        ? 'Fresh snapshot run started. Ops Pulse will fetch the first station via chunked refresh.'
        : 'Fresh snapshot run started. Ops Pulse advances about every 15 seconds while the page is open.',
  });
}

/**
 * GET/POST /api/admin/internal/cia-snapshot/next-station
 * Return the next unfinished station for the active run without Amazon fetch.
 */
export async function ciaNextStationHandler(c: Context<{ Bindings: Env }>) {
  let runId: string | undefined;
  let claim = c.req.query('claim') === '1' || c.req.query('claim') === 'true';
  try {
    if (c.req.method === 'POST') {
      const body = (await c.req.json()) as { runId?: string; claim?: boolean };
      if (body?.runId?.trim()) runId = body.runId.trim();
      if (body?.claim) claim = true;
    } else {
      const q = c.req.query('runId')?.trim();
      if (q) runId = q;
    }
  } catch {
    /* empty body = active run */
  }

  const peek = await peekNextCiaStation(c.env, runId, { claim });
  const latest = peek.run;
  const refreshProgress = await buildRefreshProgress(c.env, latest);

  return c.json({
    status: 'ok',
    stationCode: peek.stationCode,
    done: peek.done,
    run: latest,
    window: latest
      ? { from: latest.windowFrom, to: latest.windowTo }
      : null,
    refreshProgress,
  });
}

/**
 * POST /api/admin/internal/cia-snapshot/release-claim
 * Drop an in-flight PROCESSING marker after a BFF/Cloudflare abort so the
 * station can be retried on the next continue instead of waiting 6 minutes.
 */
export async function ciaReleaseClaimHandler(c: Context<{ Bindings: Env }>) {
  let runId: string | undefined;
  let stationCode = '';
  try {
    const body = (await c.req.json()) as { runId?: string; stationCode?: string };
    if (body?.runId?.trim()) runId = body.runId.trim();
    stationCode = String(body?.stationCode ?? '').trim().toUpperCase();
  } catch {
    /* empty */
  }
  if (!stationCode) {
    return c.json({ error: 'stationCode is required', code: 'VALIDATION' }, 400);
  }

  const result = await releaseCiaStationClaim(c.env, { runId, stationCode });
  const latest = result.run;
  const refreshProgress = await buildRefreshProgress(c.env, latest);
  return c.json({
    status: 'ok',
    released: result.released,
    stationCode,
    run: latest,
    refreshProgress,
  });
}

/**
 * POST /api/admin/internal/cia-snapshot/touch-claim
 * Bump fetched_at on a PROCESSING claim so a long chunked refresh is not
 * stolen after the stale timeout.
 */
export async function ciaTouchClaimHandler(c: Context<{ Bindings: Env }>) {
  let runId: string | undefined;
  let stationCode = '';
  try {
    const body = (await c.req.json()) as { runId?: string; stationCode?: string };
    if (body?.runId?.trim()) runId = body.runId.trim();
    stationCode = String(body?.stationCode ?? '').trim().toUpperCase();
  } catch {
    /* empty */
  }
  if (!stationCode) {
    return c.json({ error: 'stationCode is required', code: 'VALIDATION' }, 400);
  }

  const result = await touchCiaStationClaim(c.env, { runId, stationCode });
  return c.json({
    status: 'ok',
    touched: result.touched,
    stationCode,
    run: result.run,
  });
}

/**
 * POST /api/admin/internal/cia-snapshot/frontend-lease
 * Heartbeat from the frontend while it is actively advancing a network run.
 * Cron uses this short lease to back off until the browser goes idle/closed.
 */
export async function ciaFrontendLeaseHandler(c: Context<{ Bindings: Env }>) {
  let runId: string | undefined;
  try {
    const body = (await c.req.json()) as { runId?: string };
    if (body?.runId?.trim()) runId = body.runId.trim();
  } catch {
    /* empty */
  }

  const lease = await touchCiaFrontendLease(c.env, runId);
  return c.json({
    status: 'ok',
    runId: lease.runId,
    touchedAt: lease.touchedAt,
  });
}

/**
 * POST /api/admin/internal/cia-snapshot/continue
 * Manually advance the active run by one station (same work a ticker-cron
 * invocation does). Optional body: { "runId": "..." }.
 */
export async function ciaContinueHandler(c: Context<{ Bindings: Env }>) {
  let runId: string | undefined;
  try {
    const body = (await c.req.json()) as { runId?: string };
    if (body?.runId?.trim()) runId = body.runId.trim();
  } catch {
    /* empty body = active run */
  }

  const tick = await processCiaSnapshotTick(c.env, runId);
  await invalidateCacheAll('cia:', createApiResponseCacheStore(c.env));
  const latest = tick.run;
  const refreshProgress = await buildRefreshProgress(c.env, latest);

  return c.json({
    status: 'ok',
    processedStation: tick.processedStation,
    done: tick.done,
    run: tick.run,
    refreshProgress,
  });
}
