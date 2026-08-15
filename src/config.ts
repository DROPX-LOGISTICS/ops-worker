/**
 * Stations this worker is permitted to run validation for. Requests for any
 * other station code are rejected with a 400 before any upstream call is made.
 */
export const ALLOWED_STATIONS: ReadonlySet<string> = new Set([
  'KGQA', 'KGQC', 'TLPA', 'TLPB', 'PEUA', 'KGQE', 'QLDA', 'KOZA', 'KLZH', 'KLZA',
  'KTUB', 'KTUR', 'ERSE', 'GDRD', 'XAPH', 'GNTF', 'GNTI', 'XAPL', 'GYMC',
  'XAPI', 'NLRC', 'NLRE', 'NLRF', 'TIRC', 'JDBD', 'JGBA', 'RPRN', 'JUGD', 'SPBE',
  'JUGF', 'KANA', 'KDJE', 'KDJG', 'SBPD', 'JUGE', 'KTUO', 'HBSC', 'AWEZ',
]);

/** Default portal login account (shared across most stations). */
export const DEFAULT_PORTAL_ACCOUNT = 'default';

/**
 * Stations that cannot use the default Amazon portal user.
 * Each maps to its own portal account_key (stored in amazon_portal_credentials).
 */
export const STATION_PORTAL_ACCOUNT: Readonly<Record<string, string>> = {
  KDJG: 'KDJG',
  JUGF: 'JUGF',
  AWEZ: 'AWEZ',
  KGQE: 'KGQE',
  HBSC: 'HBSC',
};

/** Resolve which portal credential / session account to use for a station. */
export function portalAccountKeyForStation(stationCode?: string | null): string {
  const code = (stationCode ?? '').trim().toUpperCase();
  if (!code) return DEFAULT_PORTAL_ACCOUNT;
  return STATION_PORTAL_ACCOUNT[code] ?? DEFAULT_PORTAL_ACCOUNT;
}

export function isDedicatedPortalStation(stationCode?: string | null): boolean {
  return portalAccountKeyForStation(stationCode) !== DEFAULT_PORTAL_ACCOUNT;
}

/**
 * Amazon's proxy gateway is a single POST endpoint that dispatches based on
 * `resourcePath` + `processName` in the body. Traffic showed two parallel API
 * generations in flight ("cod" legacy vs "codNAWS" / v1). We standardise on
 * the v1 endpoints here; if Amazon deprecates the legacy ones or flips the
 * default, this is the only place that needs to change.
 */
export const AMAZON_RESOURCES = {
  getDrivers: { resourcePath: '/v1/getDrivers', processName: 'codNAWS' },
  getDriverReconciliation: { resourcePath: '/v1/getDriverReconciliation', processName: 'codNAWS' },
  /** Ageing dashboard drill-down (expected cash). Times in request are unix seconds. */
  getAgeingDrillDownData: {
    resourcePath: '/os/getDrillDownData',
    processName: 'oculus',
    httpMethod: 'post' as const,
  },
  getStationLiabilitySummary: { resourcePath: '/v1/getStationLiabilitySummary', processName: 'codNAWS' },
  /** Bank deposits page uses legacy `cod` (richer remittanceId / stationVariance). */
  getRemittance: {
    resourcePath: '/getRemittance',
    processName: 'cod',
  },
  /** Remittance Excel/details — tmSystem returns correct totals (cod legacy often zeros). */
  getRemittanceDetailsForExcel: {
    resourcePath: '/v1/getRemittanceDetailsForExcel',
    processName: 'tmSystem',
  },
} as const;

/** Prior calendar days for Cash In Associate snapshots (excludes today). */
export const CIA_LOOKBACK_DAYS = 31;

/**
 * Interactive / Free-plan reconcile chunk size (days). Full 31-day ERSE pulls
 * hit Cloudflare Error 1102 in one isolate; each chunk is a separate Worker
 * invocation with its own CPU budget.
 */
export const CIA_REFRESH_CHUNK_DAYS = 7;

/** Max concurrent getRemittanceDetailsForExcel calls in CIA reconcile. */
export const CIA_REMITTANCE_DETAILS_CONCURRENCY = 3;

/**
 * Cap on getRemittanceDetailsForExcel calls per station (subrequest budget).
 * Kept modest because CIA also does 3 remittance list fetches + ageing pages.
 * Most recent remittances win; older CIA rows simply stay `pending`.
 */
export const CIA_REMITTANCE_DETAILS_MAX = 12;

/**
 * How many locked ~15-day bank-deposit portal windows to fetch per station.
 * 3 × 15 days covers the 31-day CIA analysis window plus prior deposits.
 */
export const CIA_REMITTANCE_FETCH_COUNT = 3;

/**
 * Marker written while a station tick is in-flight. If the Worker dies after
 * claiming but before finishing, a later tick reclaims stale markers.
 */
export const CIA_PROCESSING_MARKER = '__PROCESSING__';

/**
 * Marker written after a station fails its first fetch. These stations are
 * retried once after all untouched stations have had their turn.
 */
export const CIA_RETRY_PENDING_MARKER = '__RETRY_PENDING__';

/**
 * Marker written after a cron tick saved one 7-day chunk and more chunks remain.
 * The next ticker may claim immediately (not an in-flight fetch).
 */
export const CIA_CHUNK_PENDING_MARKER = '__CHUNK_PENDING__';

/**
 * Reclaim in-flight station claims older than this (ms).
 * A full 31-day station refresh is several live-range chunks and often exceeds
 * 6 minutes (ERSE-sized stations). Heartbeats bump fetched_at between chunks.
 */
export const CIA_PROCESSING_STALE_MS = 20 * 60 * 1000;

/** TTL for read-API response caching (per-isolate). Identical requests within this window share one upstream round-trip. */
export const API_CACHE_TTL_MS = 60_000;

/** Longer TTL for expensive live CIA date-range reconciles (Amazon multi-page). */
export const CIA_LIVE_RANGE_CACHE_TTL_MS = 5 * 60_000;

/** Tolerance below which a monetary/count value is treated as zero. */
export const AMOUNT_EPSILON = 0.01;

/**
 * Remittance vs ageing cash may differ by up to ₹1 (rounding / coin noise).
 * Within this band treat as matched and skip pendingLiabilities.
 */
export const REMITTANCE_CASH_TOLERANCE = 1;

/** Default workforce portal host (DSP associates / DA console). */
export const DEFAULT_WORKFORCE_BASE_URL = 'https://logistics.amazon.in';

/**
 * DropX DSP company id on logistics.amazon.in workforce APIs.
 * Override with WORKFORCE_COMPANY_ID env if Amazon rotates it.
 */
export const DEFAULT_WORKFORCE_COMPANY_ID = 'b63603e9-36e2-4656-9b87-c421489a64a9';

export function workforceBaseUrl(env: { WORKFORCE_BASE_URL?: string }): string {
  return (env.WORKFORCE_BASE_URL ?? DEFAULT_WORKFORCE_BASE_URL).replace(/\/$/, '');
}

export function workforceCompanyId(env: { WORKFORCE_COMPANY_ID?: string }): string {
  return (env.WORKFORCE_COMPANY_ID ?? DEFAULT_WORKFORCE_COMPANY_ID).trim();
}

/** Workforce API paths (extend as more endpoints are wired). */
export const WORKFORCE_RESOURCES = {
  fetchDSPAssociates: '/workforce/api/v1/fetchDSPAssociates',
} as const;
