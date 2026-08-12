import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';
import { getBusinessDayRange } from '../utils/dateRange';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';

interface LiabilityProbeBody {
  stationCode?: string;
  /** YYYY-MM-DD business date in IST. Defaults to today (IST). */
  date?: string;
}

function todayIstYmd(): string {
  // Approximate IST as UTC+5:30 for "today" label.
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Smoke-test the stored Amazon session by calling getStationLiabilitySummary
 * (same upstream as the portal Cash Overview). Useful from Postman without
 * running the full validate pipeline.
 */
export async function liabilitySummaryHandler(c: Context<{ Bindings: Env }>) {
  let body: LiabilityProbeBody = {};
  try {
    body = await c.req.json<LiabilityProbeBody>();
  } catch {
    /* empty body → defaults */
  }

  const stationCode = (body.stationCode || c.env.AMAZON_LOGIN_STATION_CODE || 'TIRC').trim().toUpperCase();
  if (!ALLOWED_STATIONS.has(stationCode)) {
    throw new ValidationInputError(`Unknown or missing station code: ${stationCode}`);
  }

  const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayIstYmd();
  const range = getBusinessDayRange(date, Number(c.env.BUSINESS_DAY_START_HOUR_IST ?? '5'));

  const ensured = await ensureValidAmazonSession(c.env, {
    triggeredBy: `probe-liability:${stationCode}`,
    notifyOnFailure: true,
    stationCode,
  });
  if (!ensured.ok) {
    return c.json(
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

  const provider = createStationDataProvider(c.env);
  const summary = await provider.getStationLiabilitySummary(stationCode, range, ensured.auth);

  return c.json({
    status: 'ok',
    stationCode,
    date,
    dateRange: range,
    sessionSource: ensured.source,
    summary,
  });
}
