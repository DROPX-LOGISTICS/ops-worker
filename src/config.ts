/**
 * Stations this worker is permitted to run validation for. Requests for any
 * other station code are rejected with a 400 before any upstream call is made.
 */
export const ALLOWED_STATIONS: ReadonlySet<string> = new Set([
  'KGQA', 'KGQC', 'TLPA', 'TLPB', 'PEUA', 'KGQE', 'QLDA', 'KOZA', 'KLZH', 'KLZA',
  'KTUB', 'ERSN', 'KTUR', 'ERSE', 'GDRD', 'XAPH', 'GNTF', 'GNTI', 'XAPL', 'GYMC',
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
} as const;

/** Tolerance below which a monetary/count value is treated as zero. */
export const AMOUNT_EPSILON = 0.01;
