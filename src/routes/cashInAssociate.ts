import type { Context } from 'hono';
import type { Env, CiaStationSummary } from '../types';
import { ALLOWED_STATIONS, API_CACHE_TTL_MS, CIA_PROCESSING_MARKER } from '../config';
import { createCiaSnapshotStore, createApiResponseCacheStore } from '../store/factory';
import { ValidationInputError } from '../errors';
import { round2 } from '../utils/number';
import { cachedJson, invalidateCacheAll } from '../utils/ttlCache';
import {
  processCiaSnapshotTick,
  refreshCiaStation,
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
  };
}

type CiaReadResult =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'not_found'; body: Record<string, unknown> };

/**
 * GET /api/admin/executive/cash-in-associate?stationCode=KTUO
 * Serves the latest completed snapshot for one station (60s cached).
 */
export async function ciaStationHandler(c: Context<{ Bindings: Env }>) {
  const stationCode = (c.req.query('stationCode') ?? '').trim().toUpperCase();
  if (!stationCode) throw new ValidationInputError('stationCode is required');
  if (!ALLOWED_STATIONS.has(stationCode)) {
    throw new ValidationInputError(`Station ${stationCode} is not allowed`);
  }

  const shared = createApiResponseCacheStore(c.env);
  const { value, cacheHit } = await cachedJson<CiaReadResult>(
    `cia:station:${stationCode}`,
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

      const snap = await store.getStationSnapshot(run.id, stationCode);
      if (!snap || snap.error === CIA_PROCESSING_MARKER) {
        return {
          kind: 'not_found',
          body: {
            status: 'not_found',
            code: 'STATION_NOT_IN_SNAPSHOT',
            message: `Station ${stationCode} missing from snapshot run ${run.id}`,
            run: { id: run.id, asOfDate: run.asOfDate, status: run.status },
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
 * `stationCode` via query param or JSON body refreshes one station
 * synchronously. Omit to start/resume the full network snapshot; the
 * every-3-minutes ticker cron then processes one station per tick.
 */
export async function ciaRefreshHandler(c: Context<{ Bindings: Env }>) {
  let stationCode = (c.req.query('stationCode') ?? '').trim().toUpperCase();
  if (!stationCode) {
    try {
      const body = (await c.req.json()) as { stationCode?: string };
      if (body?.stationCode?.trim()) stationCode = body.stationCode.trim().toUpperCase();
    } catch {
      /* empty body = full run */
    }
  }

  if (stationCode) {
    if (!ALLOWED_STATIONS.has(stationCode)) {
      throw new ValidationInputError(`Station ${stationCode} is not allowed`);
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
