import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { AmazonLogisticsProvider } from '../providers/AmazonLogisticsProvider';
import { getBusinessDayRange, getRemittancePortalFetchRange, todayIstYmd } from '../utils/dateRange';
import { requireAmazonSessionOrThrow, respondCached } from './executiveAmazon';
import { prepareDepositStatus, reconciliationStatus, remittanceStatus } from '../services/codStatus';

/** Admin-only bridge. OpsPulse resolves the station from its authorized location/master;
 * unlike the legacy cron roster, the interactive view must allow master-added AMXL stations. */
export async function codStatusHandler(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ stationCode?: string; fresh?: boolean }>();
  const stationCode = String(body.stationCode ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(stationCode)) throw new ValidationInputError('Valid station code required');
  const date = todayIstYmd();
  return respondCached(c, `cod-status:v1:${stationCode}:${date}`, body.fresh === true, async () => {
    const session = await requireAmazonSessionOrThrow(c.env, `cod-status:${stationCode}`, stationCode);
    const provider = new AmazonLogisticsProvider(c.env.AMAZON_PROXY_BASE_URL, true);
    // Match the portal's current calendar date; the pending-reconciliation value itself is cumulative.
    const range = getBusinessDayRange(date);
    async function component<T>(name: string, read: () => Promise<T>) {
      try { const data = await read(); return { state: 'ok', checkedAt: new Date().toISOString(), data }; }
      catch (error) {
        console.error('cod-status component unavailable', { stationCode, component: name, message: error instanceof Error ? error.message : 'Unknown error' });
        return { state: 'unavailable', checkedAt: new Date().toISOString(), data: null };
      }
    }
    const [reconciliation, prepareDeposit, remittances] = await Promise.all([
      component('reconciliation', async () => {
        const drivers = await provider.getActiveDrivers(stationCode, session.auth);
        return reconciliationStatus(await provider.getDriverReconciliation(stationCode, range, drivers, session.auth));
      }),
      component('prepareDeposit', async () => prepareDepositStatus(await provider.getStationLiabilitySummary(stationCode, range, session.auth))),
      component('remittances', async () => {
        let complete = true;
        const entries = await provider.getRemittances(stationCode, range, session.auth, { sources: 'both', onSourceFailure: () => { complete = false; } });
        return remittanceStatus(entries, complete, date);
      }),
    ]);
    return { status: 'ok', version: 1, stationCode, date, fetchedAt: new Date().toISOString(),
      remittanceWindow: getRemittancePortalFetchRange(date, date), reconciliation, prepareDeposit, remittances };
  });
}
