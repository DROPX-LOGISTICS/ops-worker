import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';
import {
  captureStationCashSnapshot,
  resolveStationCashSnapshot,
  runCashTidSnapshotForAllStations,
} from '../services/cashTidSnapshot';

/**
 * Manual trigger (admin key) — run capture+resolve for one station, or every station when
 * stationCode is omitted. Mirrors the nightly cron for on-demand testing/backfill.
 *
 * POST /api/admin/cash-tid-snapshot/run
 * Header: x-admin-key
 * { "stationCode": "JDBD" }  // optional
 */
export async function runCashTidSnapshotHandler(c: Context<{ Bindings: Env }>) {
  let body: { stationCode?: string } = {};
  try {
    body = await c.req.json<{ stationCode?: string }>();
  } catch {
    /* empty body -> run every station */
  }

  const stationCode = (body.stationCode || '').trim().toUpperCase();
  if (!stationCode) {
    const results = await runCashTidSnapshotForAllStations(c.env);
    return c.json({ status: 'ok', results });
  }

  if (!ALLOWED_STATIONS.has(stationCode)) {
    throw new ValidationInputError(`Unknown or missing station code: ${stationCode}`);
  }
  const resolveResult = await resolveStationCashSnapshot(c.env, stationCode);
  const captureResult = await captureStationCashSnapshot(c.env, stationCode);
  return c.json({ status: 'ok', resolve: resolveResult, capture: captureResult });
}
