import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';
import { getBusinessDayRange } from '../utils/dateRange';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { checkLiability } from '../validators/liability';

interface StationDateBody {
  stationCode?: string;
  /** YYYY-MM-DD business date in IST. Defaults to today (IST). */
  date?: string;
}

function todayIstYmd(): string {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function parseStationDate(
  c: Context<{ Bindings: Env }>,
): Promise<{ stationCode: string; date: string; range: ReturnType<typeof getBusinessDayRange> }> {
  let body: StationDateBody = {};
  try {
    body = await c.req.json<StationDateBody>();
  } catch {
    /* empty body */
  }

  const stationCode = (body.stationCode || '').trim().toUpperCase();
  if (!stationCode) {
    throw new ValidationInputError('stationCode is required');
  }
  if (!ALLOWED_STATIONS.has(stationCode)) {
    throw new ValidationInputError(`Unknown or missing station code: ${stationCode}`);
  }

  const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayIstYmd();
  const range = getBusinessDayRange(date, Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '0'));
  return { stationCode, date, range };
}

async function requireAmazonSession(c: Context<{ Bindings: Env }>, triggeredBy: string) {
  const ensured = await ensureValidAmazonSession(c.env, {
    triggeredBy,
    notifyOnFailure: true,
  });
  if (!ensured.ok) {
    return {
      ok: false as const,
      response: c.json(
        {
          status: 'failed',
          code: ensured.code,
          error: ensured.error,
          needsLocalLogin: Boolean(ensured.needsLocalLogin),
        },
        ensured.needsLocalLogin ? 503 : 401,
      ),
    };
  }
  return { ok: true as const, auth: ensured.auth, sessionSource: ensured.source };
}

/**
 * Executive Reconciliation / station change:
 * getDrivers → getDriverReconciliation, return both payloads.
 *
 * POST /api/admin/executive/driver-reconciliation
 * Header: x-admin-key
 * { "stationCode": "JDBD", "date": "2026-08-02" }
 */
export async function driverReconciliationHandler(c: Context<{ Bindings: Env }>) {
  const { stationCode, date, range } = await parseStationDate(c);

  const session = await requireAmazonSession(c, `executive-recon:${stationCode}`);
  if (!session.ok) return session.response;

  const provider = createStationDataProvider(c.env);
  const drivers = await provider.getActiveDrivers(stationCode, session.auth);
  const reconciliation = await provider.getDriverReconciliation(
    stationCode,
    range,
    drivers,
    session.auth,
  );

  return c.json({
    status: 'ok',
    stationCode,
    date,
    dateRange: range,
    sessionSource: session.sessionSource,
    drivers,
    driverCount: drivers.length,
    reconciliation,
    reconciliationCount: reconciliation.length,
  });
}

/**
 * Run SCC (frontend, for now):
 * getStationLiabilitySummary + zero-check helper for the UI.
 *
 * POST /api/admin/executive/liability-summary
 * Header: x-admin-key
 * { "stationCode": "JDBD", "date": "2026-08-02" }
 */
export async function liabilitySummaryExecutiveHandler(c: Context<{ Bindings: Env }>) {
  const { stationCode, date, range } = await parseStationDate(c);

  const session = await requireAmazonSession(c, `executive-liability:${stationCode}`);
  if (!session.ok) return session.response;

  const provider = createStationDataProvider(c.env);
  const summary = await provider.getStationLiabilitySummary(stationCode, range, session.auth);
  const check = checkLiability(summary);

  return c.json({
    status: 'ok',
    stationCode,
    date,
    dateRange: range,
    sessionSource: session.sessionSource,
    summary,
    check,
  });
}

/**
 * Remittance list (frontend later / optional now):
 * getRemittance for the station/business day.
 *
 * POST /api/admin/executive/remittance
 * Header: x-admin-key
 * { "stationCode": "JDBD", "date": "2026-08-02" }
 */
export async function remittanceHandler(c: Context<{ Bindings: Env }>) {
  const { stationCode, date, range } = await parseStationDate(c);

  const session = await requireAmazonSession(c, `executive-remittance:${stationCode}`);
  if (!session.ok) return session.response;

  const provider = createStationDataProvider(c.env);
  const remittances = await provider.getRemittances(stationCode, range, session.auth);

  return c.json({
    status: 'ok',
    stationCode,
    date,
    dateRange: range,
    sessionSource: session.sessionSource,
    remittances,
    remittanceCount: remittances.length,
  });
}
