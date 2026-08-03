import type { Context } from 'hono';
import type { AmazonAuthContext, Driver, Env, ShipmentSettlementDetail } from '../types';
import { ProviderError, ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';
import { getBusinessDayRange, type DateRange } from '../utils/dateRange';
import { createStationDataProvider } from '../providers/factory';
import type { StationDataProvider } from '../providers/StationDataProvider';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { checkLiability } from '../validators/liability';
import { buildExpectedCash } from '../utils/expectedCash';

/** Keep low — Amazon often 401/500s when many shipment calls run at once. */
const SHIPMENT_FETCH_CONCURRENCY = 3;
const SHIPMENT_FETCH_RETRIES = 3;

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableShipmentError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  // Same cookie works for getDrivers/recon — intermittent 401/403/502 on shipment
  // calls are almost always concurrency/rate noise, not a real session death.
  return (
    err.code === 'AMAZON_SESSION_EXPIRED' ||
    err.code === 'PROVIDER_UPSTREAM_ERROR' ||
    err.code === 'PROVIDER_NETWORK_ERROR' ||
    err.status === 401 ||
    err.status === 403 ||
    err.status === 502
  );
}

async function fetchShipmentsForDriverWithRetry(
  provider: StationDataProvider,
  stationCode: string,
  range: DateRange,
  employeeId: number,
  auth: AmazonAuthContext,
): Promise<ShipmentSettlementDetail[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SHIPMENT_FETCH_RETRIES; attempt++) {
    try {
      return await provider.getDriverShipmentListDetails(stationCode, range, employeeId, auth);
    } catch (err) {
      lastErr = err;
      if (attempt < SHIPMENT_FETCH_RETRIES && isRetryableShipmentError(err)) {
        await sleep(200 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function fetchShipmentsByDriver(
  provider: StationDataProvider,
  stationCode: string,
  range: DateRange,
  drivers: Driver[],
  auth: AmazonAuthContext,
): Promise<{ map: Map<number, ShipmentSettlementDetail[]>; failures: { employeeId: number; error: string }[] }> {
  const failures: { employeeId: number; error: string }[] = [];
  const lists = await mapPool(drivers, SHIPMENT_FETCH_CONCURRENCY, async (driver) => {
    try {
      return await fetchShipmentsForDriverWithRetry(
        provider,
        stationCode,
        range,
        driver.employeeId,
        auth,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`shipment fetch failed for employeeId=${driver.employeeId}:`, message);
      failures.push({
        employeeId: driver.employeeId,
        error: message.includes('session expired')
          ? 'Amazon shipment call failed after retries (likely rate-limit; session still used for drivers/recon)'
          : message.slice(0, 200),
      });
      return [] as ShipmentSettlementDetail[];
    }
  });

  const map = new Map<number, ShipmentSettlementDetail[]>();
  drivers.forEach((driver, i) => {
    map.set(driver.employeeId, lists[i] ?? []);
  });
  return { map, failures };
}

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
 * getDrivers → getDriverReconciliation + per-driver shipment cash totals.
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

  // Reconciliation is one bulk call; shipments are per-driver — run both in parallel.
  const [reconciliation, shipmentResult] = await Promise.all([
    provider.getDriverReconciliation(stationCode, range, drivers, session.auth),
    fetchShipmentsByDriver(provider, stationCode, range, drivers, session.auth),
  ]);

  const expectedCash = buildExpectedCash(drivers, shipmentResult.map);

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
    expectedCash,
    expectedCashWarnings: shipmentResult.failures.length
      ? { failedDriverCount: shipmentResult.failures.length, failures: shipmentResult.failures }
      : undefined,
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
