/**
 * Stations closed in People (HRMS) - suspended or inactive in the company
 * database's Location Master. Scheduled fetches skip them so a location
 * suspended in HRMS stops being pulled without a code change or redeploy.
 *
 * Needs COMPANY_SUPABASE_URL + COMPANY_SUPABASE_SERVICE_ROLE_KEY; without them
 * (or on a lookup failure) nothing extra is skipped and ALLOWED_STATIONS rules.
 */
const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; codes: Set<string> } | null = null;

type ClosureEnv = { COMPANY_SUPABASE_URL?: string; COMPANY_SUPABASE_SERVICE_ROLE_KEY?: string };

export async function closedStationCodes(env: ClosureEnv): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.codes;
  const url = env.COMPANY_SUPABASE_URL;
  const key = env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  try {
    const res = await fetch(`${url}/rest/v1/stations?select=station_code&or=(is_active.eq.false,lifecycle_status.eq.suspended)`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ station_code: string | null }>;
    const codes = new Set(rows.map((row) => (row.station_code ?? '').trim().toUpperCase()).filter(Boolean));
    cache = { at: Date.now(), codes };
    return codes;
  } catch (err) {
    console.error('Closed-station lookup failed (using ALLOWED_STATIONS only)', err);
    return cache?.codes ?? new Set();
  }
}

/** ALLOWED_STATIONS (or the given codes) minus stations closed in People, sorted. */
export async function openStationCodes(env: ClosureEnv, codes: Iterable<string>): Promise<string[]> {
  const closed = await closedStationCodes(env);
  return [...codes].filter((code) => !closed.has(code)).sort();
}

/** Last looked-up closures, for synchronous station lists; refreshed by closedStationCodes (cron start). */
export function cachedClosedStationCodes(): Set<string> {
  return cache?.codes ?? new Set();
}
