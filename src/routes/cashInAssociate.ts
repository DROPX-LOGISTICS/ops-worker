import type { Context } from 'hono';
import type { Env, CiaStationSummary, CiaStationPayload } from '../types';
import { ALLOWED_STATIONS, API_CACHE_TTL_MS, CIA_PROCESSING_MARKER } from '../config';
import { createCiaSnapshotStore, createApiResponseCacheStore } from '../store/factory';
import { ValidationInputError } from '../errors';
import { round2 } from '../utils/number';
import { addDaysYmd, daysBetweenYmd, todayIstYmd } from '../utils/dateRange';
import { cachedJson, invalidateCacheAll } from '../utils/ttlCache';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { loadWorkforceRosterMap } from '../services/workforceRoster';
import { reconcileCashInAssociate } from '../services/cashInAssociate';
import {
  processCiaSnapshotTick,
  refreshCiaStation,
  saveCiaStationPayload,
  startCiaSnapshotRun,
} from '../services/ciaSnapshotRunner';

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
    const yesterday = addDaysYmd(todayIstYmd(), -1);
    const earliest = addDaysYmd(yesterday, -89);
    if (fromDateQuery < earliest || toDateQuery > yesterday) {
      throw new ValidationInputError(
        `Date range must stay between ${earliest} and ${yesterday} (up to 90 days).`,
      );
    }
    if (daysBetweenYmd(fromDateQuery, toDateQuery) > 89) {
      throw new ValidationInputError('Date range cannot exceed 90 days');
    }
  }

  const shared = createApiResponseCacheStore(c.env);
  const cacheKey = fromDateQuery && toDateQuery
    ? `cia:station-live:${stationCode}:${fromDateQuery}:${toDateQuery}`
    : `cia:station:${stationCode}:${asOfDateQuery || 'latest'}`;
  const { value, cacheHit } = await cachedJson<CiaReadResult>(
    cacheKey,
    API_CACHE_TTL_MS,
    async () => {
      const store = createCiaSnapshotStore(c.env);
      const sinceDate = addDaysYmd(todayIstYmd(), -90);
      const recentRuns = await store.listReadableRunsSince(sinceDate);
      const availableReportDates = [...new Set(recentRuns.map((r) => r.asOfDate))].sort(
        (a, b) => b.localeCompare(a),
      );

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
        const workforce = await loadWorkforceRosterMap(c.env, { accountKey: ensured.accountKey });
        const payload = await reconcileCashInAssociate({
          stationCode,
          fromDate: fromDateQuery,
          toDate: toDateQuery,
          startHourIst: Number(c.env.BUSINESS_DAY_START_HOUR_IST || '5') || 5,
          provider,
          auth: ensured.auth,
          workforceByTransporterId: workforce.byTransporterId,
          // Exact UI range — do not shift to last deposit (must match Excel window).
          alignDepositCycle: false,
          // Skip remittance line-item details on interactive live range (CF 1102).
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
            availableReportDates,
            mode: 'live_range',
          },
        };
      }

      const run = asOfDateQuery
        ? await store.getReadableRunByAsOfDate(asOfDateQuery)
        : await store.getLatestReadableRun();

      if (!run) {
        return {
          kind: 'not_found',
          body: {
            status: 'not_found',
            code: asOfDateQuery ? 'NO_CIA_SNAPSHOT_FOR_DATE' : 'NO_CIA_SNAPSHOT',
            message: asOfDateQuery
              ? `No Cash In Associate report saved for ${asOfDateQuery}. Try another date or refresh this station.`
              : 'No Cash In Associate snapshot yet. Wait for the 06:00 IST cron or POST refresh.',
            availableReportDates,
          },
        };
      }

      const snap = await store.getStationSnapshot(run.id, stationCode);
      if (!snap || snap.error === CIA_PROCESSING_MARKER) {
        return {
          kind: 'not_found',
          body: {
            status: 'not_found',
            code: 'STATION_NOT_IN_SNAPSHOT',
            message: `Station ${stationCode} is not in the report saved for ${run.asOfDate}.`,
            run: { id: run.id, asOfDate: run.asOfDate, status: run.status },
            availableReportDates,
          },
        };
      }

      return {
        kind: 'ok',
        body: {
          status: 'ok',
          asOfDate: run.asOfDate,
          window: { from: run.windowFrom, to: run.windowTo },
          runStatus: run.status,
          runId: run.id,
          stationCode: snap.stationCode,
          snapshotStatus: snap.status,
          error: snap.error,
          fetchedAt: snap.fetchedAt,
          summary: snap.summary,
          ledger: snap.payload.ledger,
          pendingDrivers: snap.payload.pendingDrivers,
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
 * Network rollup of CIA totals across all stations from the latest snapshot (60s cached).
 */
export async function ciaNetworkHandler(c: Context<{ Bindings: Env }>) {
  const shared = createApiResponseCacheStore(c.env);
  const { value, cacheHit } = await cachedJson<CiaReadResult>(
    'cia:network',
    API_CACHE_TTL_MS,
    async () => {
      const store = createCiaSnapshotStore(c.env);
      const run = await store.getLatestReadableRun();
      if (!run) {
        return {
          kind: 'not_found',
          body: {
            status: 'not_found',
            code: 'NO_CIA_SNAPSHOT',
            message:
              'No Cash In Associate snapshot yet. Wait for the 06:00 IST cron or POST refresh.',
          },
        };
      }

      const snaps = await store.listFinishedStationSnapshots(run.id);
      const okSummaries = snaps.filter((s) => s.status === 'ok').map((s) => s.summary);
      const totals = sumSummaries(okSummaries);

      return {
        kind: 'ok',
        body: {
          status: 'ok',
          asOfDate: run.asOfDate,
          window: { from: run.windowFrom, to: run.windowTo },
          run: {
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            stationsTotal: run.stationsTotal,
            stationsOk: run.stationsOk,
            stationsFailed: run.stationsFailed,
          },
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
 * POST /api/admin/executive/cash-in-associate/refresh
 * - Body `{ stationCode, precomputedPayload }` → persist a payload built by the
 *   BFF from live-range chunks (avoids Error 1102 on full-window sync).
 * - Body `{ stationCode }` → sync refresh (chunked via PUBLIC_WORKER_URL when set).
 * - Empty body → start/resume full network snapshot (ticker advances stations).
 */
export async function ciaRefreshHandler(c: Context<{ Bindings: Env }>) {
  let stationCode = (c.req.query('stationCode') ?? '').trim().toUpperCase();
  let precomputedPayload: CiaStationPayload | null = null;
  try {
    const body = (await c.req.json()) as {
      stationCode?: string;
      precomputedPayload?: CiaStationPayload;
    };
    if (body?.stationCode?.trim()) stationCode = body.stationCode.trim().toUpperCase();
    if (body?.precomputedPayload && typeof body.precomputedPayload === 'object') {
      precomputedPayload = body.precomputedPayload;
    }
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

  const { run, resumed } = await startCiaSnapshotRun(c.env);
  await invalidateCacheAll('cia:', createApiResponseCacheStore(c.env));

  return c.json({
    status: 'accepted',
    resumed,
    run,
    message:
      'Snapshot run started. The ticker cron processes one station every ~3 minutes; ' +
      'poll the network endpoint or POST the continue endpoint to advance manually.',
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

  return c.json({
    status: 'ok',
    processedStation: tick.processedStation,
    done: tick.done,
    run: tick.run,
  });
}
