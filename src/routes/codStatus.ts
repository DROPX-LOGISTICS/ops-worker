import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { AmazonLogisticsProvider } from '../providers/AmazonLogisticsProvider';
import { getBusinessDayRange, getPrepareDepositRange, getRemittancePortalFetchRange, todayIstYmd } from '../utils/dateRange';
import { requireAmazonSessionOrThrow, respondCached } from './executiveAmazon';
import { prepareDepositStatus, remittanceStatus } from '../services/codStatus';
import { reconciliationWithSccCash } from '../services/codCashCoverage';
import { createWorkforceAssociateStore } from '../store/factory';

/** Admin-only bridge. OpsPulse resolves the station from its authorized location/master;
 * unlike the legacy cron roster, the interactive view must allow master-added AMXL stations. */
export async function codStatusHandler(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ stationCode?: string; fresh?: boolean }>();
  const stationCode = String(body.stationCode ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(stationCode)) throw new ValidationInputError('Valid station code required');
  const date = todayIstYmd();
  return respondCached(c, `cod-status:v5:${stationCode}:${date}`, body.fresh === true, async () => {
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
        const [drivers, cash] = await Promise.all([
          provider.getActiveDrivers(stationCode, session.auth),
          provider.getOutstandingAssociateCash(stationCode, session.auth),
        ]);
        const entries = await provider.getDriverReconciliation(stationCode, range, drivers, session.auth);
        const known = new Set(entries.map(d => d.driverInfo.id));
        const missingIds = [...new Set(cash.map(p => p.driverId).filter((id): id is string => !!id && !known.has(id)))];
        // Name lookup is optional; cash remains visible by Driver ID if unavailable.
        const roster = missingIds.length ? await createWorkforceAssociateStore(c.env).getByTransporterIds(missingIds).catch(() => new Map()) : new Map();
        const names = new Map<string, string>();
        for (const [id, person] of roster) if (person.fullName) names.set(id, person.fullName);
        return reconciliationWithSccCash(entries, cash, names);
      }),
      component('prepareDeposit', async () => ({...prepareDepositStatus(await provider.getStationLiabilitySummary(stationCode, getPrepareDepositRange(date), session.auth)), sourceScope: 'outstanding_history', sourceWindow: getPrepareDepositRange(date)})),
      component('remittances', async () => {
        const entries = await provider.getRemittances(stationCode, range, session.auth, { sources: 'primary' });
        return remittanceStatus(entries, true, date);
      }),
    ]);
    return { status: 'ok', version: 1, stationCode, date, fetchedAt: new Date().toISOString(),
      remittanceWindow: getRemittancePortalFetchRange(date, date), reconciliation, prepareDeposit, remittances };
  });
}
