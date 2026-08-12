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
 * Ops cutoff is 5:00 IST (cash/deposits before 5 AM belong to the previous
 * day). Override with BUSINESS_DAY_START_HOUR_IST in wrangler.toml.
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

/**
 * Ops business date for an instant.
 * Cash / deposits before `startHourIst` (default 5:00 IST) belong to the
 * previous calendar day — stations often create the prior day's remittance
 * after midnight, before ~4–5 AM.
 */
export function businessYmdFromEpochMs(ms: number, startHourIst = 5): string {
  const ist = new Date(ms + IST_OFFSET_MINUTES * 60 * 1000);
  const hour = ist.getUTCHours();
  const calendar = todayIstYmd(ms);
  if (hour < startHourIst) return addDaysYmd(calendar, -1);
  return calendar;
}

const NAIVE_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/;

/**
 * Parse ageing `lastUpdatedTime` to UTC epoch ms.
 * Unzoned `YYYY-MM-DD HH:mm:ss` is IST wall clock (Amazon India export).
 */
export function parseAgeingUpdatedMs(lastUpdatedTime: string | null | undefined): number | null {
  if (!lastUpdatedTime) return null;
  const trimmed = lastUpdatedTime.trim();
  if (!trimmed) return null;

  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed) || /T.*[zZ]|T.*[+-]\d{2}/.test(trimmed);
  if (hasZone) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }

  const m = NAIVE_TS_RE.exec(trimmed);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? '0');
  const minute = Number(m[5] ?? '0');
  const second = Number(m[6] ?? '0');
  return Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MINUTES * 60 * 1000;
}

/** Business YYYY-MM-DD for an ageing lastUpdatedTime string. */
export function ageingBusinessYmd(
  lastUpdatedTime: string | null | undefined,
  startHourIst = 5,
): string | null {
  const ms = parseAgeingUpdatedMs(lastUpdatedTime);
  if (ms == null) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(lastUpdatedTime ?? '').trim());
    return m ? m[1]! : null;
  }
  return businessYmdFromEpochMs(ms, startHourIst);
}

/**
 * Excel / Amazon ageing pivot date: IST calendar day of lastUpdatedTime
 * (no 5 AM ops cutoff). Unzoned `YYYY-MM-DD …` uses the date prefix as-is.
 */
export function ageingCalendarYmd(lastUpdatedTime: string | null | undefined): string | null {
  if (!lastUpdatedTime) return null;
  const trimmed = lastUpdatedTime.trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed) || /T.*[zZ]|T.*[+-]\d{2}/.test(trimmed);
  if (!hasZone) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
    if (m) return m[1]!;
    const part = trimmed.split(/[\sT]/)[0];
    return part && /^\d{4}-\d{2}-\d{2}$/.test(part) ? part : null;
  }
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return todayIstYmd(ms);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  return m ? m[1]! : null;
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
