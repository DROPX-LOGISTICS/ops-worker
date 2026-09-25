import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';
import {
  backfillMorningCarryover,
  captureStationCashSnapshot,
  runCashTidSnapshotForAllStations,
} from '../services/cashTidSnapshot';
import { addDaysYmd, todayIstYmd } from '../utils/dateRange';

/**
 * Manual trigger (admin key) — run capture for one station, or every station when
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
  const captureResult = await captureStationCashSnapshot(c.env, stationCode);
  return c.json({ status: 'ok', capture: captureResult });
}

/**
 * One-time bootstrap: anchor the previous day's cash that a morning recon batch moved into
 * `date` (Cash At Station updated before `cutoffIst`) back to `anchorDate`. Preview only
 * unless `apply: true`. Omit stationCode to run every allowed station.
 *
 * POST /api/admin/cash-tid-snapshot/backfill-carryover
 * Header: x-admin-key
 * { "stationCode": "PEUA", "date": "2026-09-25", "anchorDate": "2026-09-24", "cutoffIst": "11:00", "apply": false }
 */
export async function backfillCarryoverHandler(c: Context<{ Bindings: Env }>) {
  let body: { stationCode?: string; date?: string; anchorDate?: string; cutoffIst?: string; apply?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body */
  }
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const date = body.date && ymd.test(body.date) ? body.date : todayIstYmd();
  const anchorDate = body.anchorDate && ymd.test(body.anchorDate) ? body.anchorDate : addDaysYmd(date, -1);
  const cutoffIst = body.cutoffIst && /^\d{1,2}:\d{2}$/.test(body.cutoffIst) ? body.cutoffIst : '11:00';
  if (anchorDate >= date) throw new ValidationInputError('anchorDate must be before date');
  const apply = body.apply === true;

  const stationCode = (body.stationCode || '').trim().toUpperCase();
  if (stationCode && !ALLOWED_STATIONS.has(stationCode)) {
    throw new ValidationInputError(`Unknown or missing station code: ${stationCode}`);
  }
  const stations = stationCode ? [stationCode] : [...ALLOWED_STATIONS].sort();
  const results = [];
  for (const code of stations) {
    results.push(await backfillMorningCarryover(c.env, { stationCode: code, date, anchorDate, cutoffIst, apply }));
  }
  return c.json({ status: 'ok', apply, date, anchorDate, cutoffIst, results });
}
