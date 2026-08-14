import type { Context } from 'hono';
import type { Env, AmazonAuthContext } from '../types';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS, API_CACHE_TTL_MS } from '../config';
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
import { verifyRemittanceEntry } from '../validators/remittanceVerify';
import { round2 } from '../utils/number';
import { cachedJson, invalidateCache } from '../utils/ttlCache';
import { createApiResponseCacheStore } from '../store/factory';

interface StationDateBody {
  stationCode?: string;
  /** YYYY-MM-DD business date in IST. Defaults to today (IST). */
  date?: string;
  /** When true, bypass the 60s response cache and recompute from Amazon. */
  fresh?: boolean;
}

interface RemittanceVerifyBody extends StationDateBody {
  remittanceCode?: string;
  amount?: number | string;
  /** COD period start YYYY-MM-DD (IST) — must cover remittance creationDate */
  codPeriodFrom?: string;
  /** COD period end YYYY-MM-DD (IST) — must cover remittance creationDate */
  codPeriodTo?: string;
  /** Optional portal submittedBy / createdBy check (case-insensitive) */
  submittedBy?: string;
}

async function parseStationDate(
  c: Context<{ Bindings: Env }>,
): Promise<{
  stationCode: string;
  date: string;
  range: ReturnType<typeof getBusinessDayRange>;
  fresh: boolean;
}> {
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
  const range = getBusinessDayRange(date, Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '5'));
  const fresh =
    body.fresh === true || (c.req.query('fresh') ?? '').trim() === '1';
  return { stationCode, date, range, fresh };
}

/** Session failure that must be returned as-is and never cached. */
class SessionUnavailable extends Error {
  constructor(
    readonly payload: Record<string, unknown>,
    readonly httpStatus: 401 | 503,
  ) {
    super('Amazon session unavailable');
    this.name = 'SessionUnavailable';
  }
}

async function requireAmazonSessionOrThrow(
  env: Env,
  triggeredBy: string,
  stationCode?: string,
): Promise<{ auth: AmazonAuthContext; sessionSource: string; accountKey: string }> {
  const ensured = await ensureValidAmazonSession(env, {
    triggeredBy,
    notifyOnFailure: true,
    stationCode,
  });
  if (!ensured.ok) {
    throw new SessionUnavailable(
      {
        status: 'failed',
        code: ensured.code,
        error: ensured.error,
        accountKey: ensured.accountKey,
        needsLocalLogin: Boolean(ensured.needsLocalLogin),
      },
      ensured.needsLocalLogin ? 503 : 401,
    );
  }
  return { auth: ensured.auth, sessionSource: ensured.source, accountKey: ensured.accountKey };
}

/**
 * Run `compute` behind L1 (memory) + L2 (Supabase) 60s TTL cache.
 * Session failures pass through uncached with their proper HTTP status.
 * Pass `fresh: true` to bypass and force a recompute.
 */
async function respondCached(
  c: Context<{ Bindings: Env }>,
  key: string,
  fresh: boolean,
  compute: () => Promise<Record<string, unknown>>,
) {
  const shared = createApiResponseCacheStore(c.env);
  if (fresh) {
    invalidateCache(key);
    await shared.deletePrefix(key).catch(() => undefined);
  }

  try {
    const { value, cacheHit } = await cachedJson(key, API_CACHE_TTL_MS, compute, shared);
    return c.json({ ...value, cached: fresh ? false : cacheHit });
  } catch (err) {
    if (err instanceof SessionUnavailable) {
      return c.json(err.payload, err.httpStatus);
    }
    throw err;
  }
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
  const { stationCode, date, range, fresh } = await parseStationDate(c);

  return respondCached(c, `exec:recon:${stationCode}:${date}`, fresh, async () => {
    const session = await requireAmazonSessionOrThrow(
      c.env,
      `executive-recon:${stationCode}`,
      stationCode,
    );

    const provider = createStationDataProvider(c.env);
    const drivers = await provider.getActiveDrivers(stationCode, session.auth);

    const [rawReconciliation, ageingPackages, roster] = await Promise.all([
      provider.getDriverReconciliation(stationCode, range, drivers, session.auth),
      provider.getAgeingDrillDownData(
        stationCode,
        date,
        session.auth,
        undefined,
        undefined,
        Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '5'),
      ),
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
      sameDayPendingReconTotal,
      completedReconTotal,
    } = enrichReconciliationWithAgeing(rawReconciliation, ageingPackages);

    return {
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
      sameDayPendingReconTotal,
      completedReconTotal,
      expectedCash,
      workforceRoster: {
        source: roster.source,
        count: roster.count,
        syncedAt: roster.syncedAt,
      },
    };
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
  const { stationCode, date, range, fresh } = await parseStationDate(c);

  return respondCached(c, `exec:liability:${stationCode}:${date}`, fresh, async () => {
    const session = await requireAmazonSessionOrThrow(
      c.env,
      `executive-liability:${stationCode}`,
      stationCode,
    );

    const provider = createStationDataProvider(c.env);
    const summary = await provider.getStationLiabilitySummary(stationCode, range, session.auth);
    const check = checkLiability(summary);

    return {
      status: 'ok',
      stationCode,
      date,
      dateRange: range,
      sessionSource: session.sessionSource,
      accountKey: session.accountKey,
      summary,
      check,
    };
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
  const { stationCode, date, range, fresh } = await parseStationDate(c);
  const startHourIst = Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '5');

  return respondCached(c, `exec:remittance:${stationCode}:${date}`, fresh, async () => {
    const session = await requireAmazonSessionOrThrow(
      c.env,
      `executive-remittance:${stationCode}`,
      stationCode,
    );

    const provider = createStationDataProvider(c.env);

    const [drivers, all, sameDayPackages, roster] = await Promise.all([
      provider.getActiveDrivers(stationCode, session.auth),
      provider.getRemittances(stationCode, range, session.auth),
      provider.getAgeingDrillDownData(stationCode, date, session.auth, undefined, undefined, startHourIst),
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

    return {
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
    };
  });
}

/**
 * Verify remittance for COD Submission.
 *
 * POST /api/admin/executive/remittance/verify
 * {
 *   "stationCode": "GNTI",
 *   "date": "2026-08-10",          // deposit date = submissionDate IST
 *   "codPeriodFrom": "2026-08-09",  // must cover creationDate IST
 *   "codPeriodTo": "2026-08-09",
 *   "remittanceCode": "AC557750",
 *   "amount": 43016,
 *   "submittedBy": "saisrihk"       // optional, case-insensitive
 * }
 */
export async function remittanceVerifyHandler(c: Context<{ Bindings: Env }>) {
  let body: RemittanceVerifyBody = {};
  try {
    body = await c.req.json<RemittanceVerifyBody>();
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
  const codPeriodFrom =
    body.codPeriodFrom && /^\d{4}-\d{2}-\d{2}$/.test(body.codPeriodFrom)
      ? body.codPeriodFrom
      : date;
  const codPeriodTo =
    body.codPeriodTo && /^\d{4}-\d{2}-\d{2}$/.test(body.codPeriodTo)
      ? body.codPeriodTo
      : codPeriodFrom;
  const range = getBusinessDayRange(date, Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '5'));
  const fresh =
    body.fresh === true || (c.req.query('fresh') ?? '').trim() === '1';

  const remittanceCode = String(body.remittanceCode ?? '').trim();
  if (!remittanceCode) {
    throw new ValidationInputError('remittanceCode is required');
  }

  const amountRaw = body.amount;
  const amount =
    typeof amountRaw === 'number'
      ? amountRaw
      : Number(String(amountRaw ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationInputError('amount must be a non-negative number');
  }

  const submittedBy = String(body.submittedBy ?? '').trim() || null;
  const cacheKey = `exec:remittance-verify:${stationCode}:${date}:${codPeriodFrom}:${codPeriodTo}:${remittanceCode.toUpperCase()}:${round2(amount)}:${(submittedBy ?? '').toLowerCase()}`;

  return respondCached(c, cacheKey, fresh, async () => {
    const session = await requireAmazonSessionOrThrow(
      c.env,
      `executive-remittance-verify:${stationCode}`,
      stationCode,
    );

    const provider = createStationDataProvider(c.env);
    // Anchor fetch on the earlier of deposit/COD-from so prior-day creations are included.
    const fetchAnchor = codPeriodFrom < date ? codPeriodFrom : date;
    const fetchRange = getBusinessDayRange(
      fetchAnchor,
      Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '5'),
    );
    const all = await provider.getRemittances(stationCode, fetchRange, session.auth);
    const result = verifyRemittanceEntry(
      all,
      remittanceCode,
      amount,
      date,
      codPeriodFrom,
      codPeriodTo,
      submittedBy,
    );

    return {
      status: 'ok',
      stationCode,
      date,
      codPeriodFrom,
      codPeriodTo,
      dateRange: range,
      remittanceCode: remittanceCode.trim().toUpperCase(),
      amount: round2(amount),
      submittedBy,
      sessionSource: session.sessionSource,
      accountKey: session.accountKey,
      ...result,
    };
  });
}
