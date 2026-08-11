export interface DateRange {
  startTime: number;
  endTime: number;
}

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Computes the epoch-ms [startTime, endTime] window the station portal uses
 * for a single business day, given a YYYY-MM-DD date interpreted in IST.
 *
 * The window shape (endTime = startTime + 24h - 1ms) and the default
 * midnight-IST start were both reverse-derived from observed API traffic
 * (dateRange pairs such as startTime=1785349800000 / endTime=1785436200000).
 * If your ops team confirms a different cutover hour, change
 * BUSINESS_DAY_START_HOUR_IST in wrangler.toml — no code changes needed.
 */
export function getBusinessDayRange(dateStr: string, startHourIst = 0): DateRange {
  const match = DATE_RE.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
  }
  const [, yStr, mStr, dStr] = match;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);

  // Midnight IST for the given calendar date, expressed as a UTC epoch ms.
  const istMidnightUtcMs = Date.UTC(year, month - 1, day) - IST_OFFSET_MINUTES * 60 * 1000;

  const startTime = istMidnightUtcMs + startHourIst * MS_PER_HOUR;
  const endTime = startTime + MS_PER_DAY - 1;

  return { startTime, endTime };
}

/** Portal bank-deposits `/getRemittance` lookback (~16 days). */
export const REMITTANCE_LOOKBACK_DAYS = 16;

/** Max ageing calendar-day span when resolving remittance pile-ups. */
export const AGEING_PENDING_LOOKBACK_DAYS = 45;

/**
 * Bank-deposits `/getRemittance` portal call uses a ~16-day lookback window
 * ending at the selected business day (many dates returned; callers filter
 * by creationDate). Matches observed traffic:
 *   startTime=1784505600000, endTime=1785888000000 → 16 days.
 */
export function getRemittanceFetchRange(dateStr: string, startHourIst = 0): DateRange {
  const day = getBusinessDayRange(dateStr, startHourIst);
  return {
    startTime: day.endTime - REMITTANCE_LOOKBACK_DAYS * MS_PER_DAY + 1,
    endTime: day.endTime,
  };
}

/**
 * Remittance portal fetch ending at max(anchor, today IST) so next-day
 * deposits after the request date remain visible within the 16-day window.
 */
export function getRemittancePortalFetchRange(
  anchorYmd: string,
  todayYmd: string,
  startHourIst = 0,
): DateRange {
  const endYmd = maxYmd(anchorYmd, todayYmd);
  return getRemittanceFetchRange(endYmd, startHourIst);
}

export function todayIstYmd(nowMs = Date.now()): string {
  const ist = new Date(nowMs + IST_OFFSET_MINUTES * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysYmd(dateStr: string, days: number): string {
  const match = DATE_RE.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
  }
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const shifted = new Date(utc + days * MS_PER_DAY);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** IST calendar YYYY-MM-DD from an epoch-ms timestamp. */
export function ymdFromIstEpochMs(ms: number): string {
  return todayIstYmd(ms);
}

export function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxYmd(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Whole calendar days between two YYYY-MM-DD values (IST dates as civil days). */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = DATE_RE.exec(fromYmd);
  const b = DATE_RE.exec(toYmd);
  if (!a || !b) {
    throw new Error(`Invalid date range "${fromYmd}" → "${toYmd}"`);
  }
  const fromUtc = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const toUtc = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/**
 * Ageing dashboard (`/os/getDrillDownData`) lastUpdatedRange in unix seconds.
 *
 * Ops / Excel exports bucket `Last Updated Time` on the **IST calendar date**.
 * Using bare UTC midnights drops early-morning IST rows (e.g. 4 Aug 00:29 IST
 * = 3 Aug 18:59 UTC) and mismatches Amazon UI date pickers in India.
 * Bounds are [IST midnight from, IST midnight of day after to) as unix seconds.
 */
export function getIstCalendarDayRangeSeconds(dateStr: string): DateRange {
  const day = getBusinessDayRange(dateStr, 0);
  return {
    startTime: Math.floor(day.startTime / 1000),
    endTime: Math.floor((day.startTime + MS_PER_DAY) / 1000),
  };
}

/**
 * Inclusive multi-day IST calendar range in unix seconds for ageing.
 * `toYmdInclusive` maps to exclusive end = next IST midnight.
 */
export function getIstCalendarRangeSeconds(fromYmd: string, toYmdInclusive: string): DateRange {
  const from = getIstCalendarDayRangeSeconds(fromYmd);
  const to = getIstCalendarDayRangeSeconds(toYmdInclusive);
  if (to.startTime < from.startTime) {
    throw new Error(`Invalid ageing range: ${fromYmd} → ${toYmdInclusive}`);
  }
  return { startTime: from.startTime, endTime: to.endTime };
}

/**
 * @deprecated Prefer {@link getIstCalendarDayRangeSeconds} for India station ageing.
 * Kept for reference to older UTC-midnight probing.
 */
export function getUtcCalendarDayRangeSeconds(dateStr: string): DateRange {
  const match = DATE_RE.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const startTime = Math.floor(Date.UTC(year, month - 1, day) / 1000);
  const endTime = startTime + 24 * 60 * 60;
  return { startTime, endTime };
}

/**
 * @deprecated Prefer {@link getIstCalendarRangeSeconds}.
 */
export function getUtcCalendarRangeSeconds(fromYmd: string, toYmdInclusive: string): DateRange {
  const from = getUtcCalendarDayRangeSeconds(fromYmd);
  const to = getUtcCalendarDayRangeSeconds(toYmdInclusive);
  if (to.startTime < from.startTime) {
    throw new Error(`Invalid ageing range: ${fromYmd} → ${toYmdInclusive}`);
  }
  return { startTime: from.startTime, endTime: to.endTime };
}
