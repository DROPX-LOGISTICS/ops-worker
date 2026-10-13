import type { AgeingPackageDetail, DriverReconciliationEntry } from '../types';
import { reconciliationStatus, codSourceTime } from './codStatus';
import { parseAgeingUpdatedMs } from '../utils/dateRange';
import { round2 } from '../utils/number';

/** SCC cash holders can be absent from getDrivers entirely. Never discard their
 * cash, use Last Scan By as ownership, or confuse an SCC update with collection. */
export function reconciliationWithSccCash(entries: DriverReconciliationEntry[], cash: AgeingPackageDetail[], names: Map<string, string> = new Map()) {
  const base = entries.length ? reconciliationStatus(entries) : {
    complete: true, driverCount: 0, pendingCount: 0, pendingAmount: 0, completedPercent: 0, drivers: [],
  };
  type Package = ReturnType<typeof reconciliationStatus>['drivers'][number]['packages'][number] & {
    source?: 'scc_cash_with_associate'; sourceUpdatedAt?: number | null;
  };
  type CashDriver = { id: string; name: string; pendingAmount: number; packages: Package[]; source?: 'scc_cash_with_associate' };
  const drivers: CashDriver[] = base.drivers.map(d => ({ ...d, packages: d.packages.map(p => ({ ...p })) }));
  const rosterIds = new Set(entries.map(d => d.driverInfo.id));
  const seen = new Map<string, { id: string; amount: number }>();
  for (const driver of drivers) for (const p of driver.packages) {
    if (!p.trackingId || seen.has(p.trackingId)) throw new Error('Duplicate or missing reconciliation tracking ID');
    seen.set(p.trackingId, { id: driver.id, amount: p.amount });
  }
  const added = new Map<string, CashDriver>();
  const conflicts: string[] = [];
  const cashIds = new Set<string>();
  let supplementedAmount = 0, supplementedCount = 0;
  for (const p of cash) {
    if (!p.trackingId || cashIds.has(p.trackingId)) throw new Error('Duplicate or missing SCC cash tracking ID');
    cashIds.add(p.trackingId);
    if (!Number.isFinite(p.receivableAmount) || p.receivableAmount < 0) throw new Error('SCC cash amount unavailable');
    const amount = round2(p.receivableAmount / 100);
    if (amount === 0) continue;
    const id = p.driverId?.trim() || `unassigned:${p.trackingId}`;
    const existing = seen.get(p.trackingId);
    if (existing) {
      if (existing.id !== id || Math.abs(existing.amount - amount) >= 0.01) conflicts.push(p.trackingId);
      continue;
    }
    // If a returned driver has since reconciled this TID, do not resurrect it
    // from a lagging SCC snapshot. Expose the source disagreement for review.
    if (rosterIds.has(id)) { conflicts.push(p.trackingId); continue; }
    let driver = added.get(id);
    if (!driver) {
      driver = { id, name: names.get(id) || (p.driverId ? `Driver ${id}` : 'Unassigned cash holder'), pendingAmount: 0, packages: [], source: 'scc_cash_with_associate' };
      added.set(id, driver);
    }
    driver.pendingAmount = round2(driver.pendingAmount + amount);
    driver.packages.push({ trackingId: p.trackingId, amount, paymentMethod: 'CASH', collectedAt: null, dateSource: null, transactionAt: null,
      source: 'scc_cash_with_associate', sourceUpdatedAt: codSourceTime(parseAgeingUpdatedMs(p.lastUpdatedTime)) });
    supplementedAmount = round2(supplementedAmount + amount); supplementedCount++;
  }
  drivers.push(...added.values());
  const driverCount = base.driverCount + added.size;
  return { ...base, complete: conflicts.length === 0, driverCount, drivers, pendingCount: drivers.length,
    pendingAmount: round2(base.pendingAmount + supplementedAmount),
    completedPercent: driverCount ? round2(100 * (driverCount - drivers.length) / driverCount) : 100,
    coverage: { source: 'scc_cash_with_associate', scope: 'all_outstanding', shipmentCount: cash.length,
      amount: round2(cash.reduce((sum,p) => sum + p.receivableAmount / 100, 0)),
      supplementedDriverCount: added.size, supplementedCount, supplementedAmount, conflictingTrackingIds: conflicts },
  };
}
