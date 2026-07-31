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
