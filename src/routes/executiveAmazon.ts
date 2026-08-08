import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';
import { getBusinessDayRange, todayIstYmd } from '../utils/dateRange';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { checkLiability } from '../validators/liability';
import { buildExpectedCashFromAgeing } from '../utils/expectedCash';
import { enrichReconciliationWithAgeing } from '../utils/reconState';
import { loadWorkforceRosterMap } from '../services/workforceRoster';
import {
  reconcileRemittancePending,
} from '../services/remittancePending';
import { round2 } from '../utils/number';

interface StationDateBody {
  stationCode?: string;
  /** YYYY-MM-DD business date in IST. Defaults to today (IST). */
  date?: string;
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

async function requireAmazonSession(
  c: Context<{ Bindings: Env }>,
  triggeredBy: string,
  stationCode?: string,
) {
  const ensured = await ensureValidAmazonSession(c.env, {
    triggeredBy,
    notifyOnFailure: true,
    stationCode,
  });
  if (!ensured.ok) {
    return {
      ok: false as const,
      response: c.json(
        {
          status: 'failed',
          code: ensured.code,
          error: ensured.error,
          accountKey: ensured.accountKey,
          needsLocalLogin: Boolean(ensured.needsLocalLogin),
        },
        ensured.needsLocalLogin ? 503 : 401,
      ),
    };
  }
  return {
    ok: true as const,
    auth: ensured.auth,
    sessionSource: ensured.source,
    accountKey: ensured.accountKey,
  };
}

/**
 * Executive Reconciliation / station change:
 * getDrivers → getDriverReconciliation + ageing expected cash.
 * Pending/completed recon amounts are corrected from ageing `state`
 * for the requested date (Cash In Associate / CASH_AT_STATION).
 *
 * POST /api/admin/executive/driver-reconciliation
 * Header: x-admin-key
 * { "stationCode": "JDBD", "date": "2026-08-02" }
 */
export async function driverReconciliationHandler(c: Context<{ Bindings: Env }>) {
  const { stationCode, date, range } = await parseStationDate(c);

  const session = await requireAmazonSession(c, `executive-recon:${stationCode}`, stationCode);
  if (!session.ok) return session.response;

  const provider = createStationDataProvider(c.env);
  const drivers = await provider.getActiveDrivers(stationCode, session.auth);

  const [rawReconciliation, ageingPackages, roster] = await Promise.all([
    provider.getDriverReconciliation(stationCode, range, drivers, session.auth),
    provider.getAgeingDrillDownData(stationCode, date, session.auth),
    loadWorkforceRosterMap(c.env),
  ]);

  const expectedCash = buildExpectedCashFromAgeing(
    drivers,
    ageingPackages,
    roster.byTransporterId,
  );
  // Ageing state is date-scoped; Amazon overallPendingRecon is cumulative.
  const {
    entries: reconciliation,
    pendingReconTotal,
    completedReconTotal,
  } = enrichReconciliationWithAgeing(rawReconciliation, ageingPackages);

  return c.json({
    status: 'ok',
    stationCode,
    date,
    dateRange: range,
    sessionSource: session.sessionSource,
    accountKey: session.accountKey,
    drivers,
    driverCount: drivers.length,
    reconciliation,
    reconciliationCount: reconciliation.length,
    pendingReconTotal,
    completedReconTotal,
    expectedCash,
    workforceRoster: {
      source: roster.source,
      count: roster.count,
      syncedAt: roster.syncedAt,
    },
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

  const session = await requireAmazonSession(c, `executive-liability:${stationCode}`, stationCode);
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
    accountKey: session.accountKey,
    summary,
    check,
  });
}

/**
 * Remittance check for a station/business day.
 * Builds a day-by-day cash ledger: expected vs remittance, exact trackingId
 * clearance from remittance details, and forwarded/pending drivers+shipments.
 *
 * POST /api/admin/executive/remittance
 * Header: x-admin-key
 * { "stationCode": "JDBD", "date": "2026-08-03" }
 */
export async function remittanceHandler(c: Context<{ Bindings: Env }>) {
  const { stationCode, date, range } = await parseStationDate(c);
  const startHourIst = Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '0');

  const session = await requireAmazonSession(c, `executive-remittance:${stationCode}`, stationCode);
  if (!session.ok) return session.response;

  const provider = createStationDataProvider(c.env);

  const [drivers, all, sameDayPackages, roster] = await Promise.all([
    provider.getActiveDrivers(stationCode, session.auth),
    provider.getRemittances(stationCode, range, session.auth),
    provider.getAgeingDrillDownData(stationCode, date, session.auth),
    loadWorkforceRosterMap(c.env),
  ]);

  const dayRemittances = all.filter(
    (r) => r.creationDate >= range.startTime && r.creationDate <= range.endTime,
  );

  const created = dayRemittances.filter((r) => r.status === 'CREATED');
  const submitted = dayRemittances.filter((r) => r.status === 'SUBMITTED');

  const remittanceCodes = [
    ...new Set(
      submitted
        .map((r) => (r.remittanceCode ?? '').trim())
        .filter(Boolean),
    ),
  ];

  const createdTotal = round2(created.reduce((sum, r) => sum + (r.actualAmount?.value ?? 0), 0));
  const submittedTotal = round2(submitted.reduce((sum, r) => sum + (r.actualAmount?.value ?? 0), 0));
  const remittanceTotalCash = round2(createdTotal + submittedTotal);

  const sameDayExpectedCash = buildExpectedCashFromAgeing(
    drivers,
    sameDayPackages,
    roster.byTransporterId,
  );
  const sameDayActive = dayRemittances.filter(
    (r) => r.status === 'CREATED' || r.status === 'SUBMITTED',
  );

  const ledgerResult = await reconcileRemittancePending({
    stationCode,
    requestDate: date,
    startHourIst,
    drivers,
    allRemittances: all,
    sameDayExpectedCash,
    sameDayRemittances: sameDayActive,
    provider,
    auth: session.auth,
    workforceByTransporterId: roster.byTransporterId,
  });

  return c.json({
    status: 'ok',
    stationCode,
    date,
    dateRange: range,
    sessionSource: session.sessionSource,
    accountKey: session.accountKey,
    remittanceTotalCash,
    created,
    createdCount: created.length,
    createdTotal,
    submitted,
    submittedCount: submitted.length,
    submittedTotal,
    remittanceCodes,
    summary: ledgerResult.summary,
    ledger: ledgerResult.ledger,
    workforceRoster: {
      source: roster.source,
      count: roster.count,
      syncedAt: roster.syncedAt,
    },
  });
}
