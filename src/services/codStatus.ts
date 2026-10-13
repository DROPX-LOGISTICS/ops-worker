import type { DriverReconciliationEntry, LiabilitySummary, RemittanceEntry } from '../types';
import { round2 } from '../utils/number';
import { todayIstYmd } from '../utils/dateRange';

export function requiredMoney(value: unknown): number {
  const money = value as { value?: unknown; unit?: string } | null;
  if (money?.value == null || money.value === '' || !Number.isFinite(Number(money.value)) || (money.unit && money.unit !== 'INR')) throw new Error('Amount unavailable');
  return round2(Number(money.value));
}
/** Portal collection and transaction timestamps are distinct. Never substitute a
 * refresh timestamp (or transaction update) for the COD collection date. */
export function codSourceTime(value: unknown, now = Date.now()): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= Date.UTC(2000, 0, 1) && n <= now ? n : null;
}
export function reconciliationStatus(entries: DriverReconciliationEntry[]) {
  if (!entries.length) throw new Error('No driver reconciliation data returned');
  const seen = new Set<string>();
  const drivers = entries.map(entry => {
    const id = entry.driverInfo?.id;
    if (!id || seen.has(id)) throw new Error('Incomplete or duplicate driver reconciliation');
    seen.add(id);
    return {
      id, name: entry.driverInfo.name, pendingAmount: requiredMoney(entry.paymentInfo?.overallPendingRecon),
      packages: (entry.paymentInfo?.overallPendingReconBreakdownList ?? []).map(item => ({
        trackingId: item.trackingId, amount: requiredMoney(item.amount), paymentMethod: item.paymentMethod,
        collectedAt: codSourceTime(item.moneyCollectionTime),
        transactionAt: codSourceTime(item.transactionTime),
      })),
    };
  });
  const pending = drivers.filter(row => Math.abs(row.pendingAmount) >= 0.01);
  // Amazon's All Drivers reconciliation view returns COD-applicable rows, not
  // the entire active roster (verified live: GNTF has 16 rows / 25 roster entries).
  // A roster-count mismatch is therefore not evidence of a partial response.
  // Empty, malformed and duplicate source rows still fail validation above.
  return { complete: true, driverCount: drivers.length, pendingCount: pending.length,
    pendingAmount: round2(pending.reduce((sum, row) => sum + row.pendingAmount, 0)),
    completedPercent: round2(100 * (drivers.length - pending.length) / drivers.length), drivers: pending };
}
export function prepareDepositStatus(summary: LiabilitySummary) {
  return { expectedAmount: requiredMoney(summary?.cashSummary?.expectedAmount), actualAmount: requiredMoney(summary?.cashSummary?.actualAmount),
    variance: requiredMoney(summary?.cashSummary?.shortExcessAmount) };
}
export function remittanceStatus(entries: RemittanceEntry[], complete: boolean, today: string) {
  const rows = [...entries].sort((a,b) => b.lastUpdated - a.lastUpdated).map(entry => ({
    id: entry.remittanceId, code: entry.remittanceCode, status: entry.status,
    expectedAmount: requiredMoney(entry.expectedAmount), actualAmount: requiredMoney(entry.actualAmount),
    variance: requiredMoney(entry.variance), createdAt: entry.creationDate || null,
    updatedAt: entry.lastUpdated || null, submittedAt: entry.submissionDate,
    createdBy: entry.createdBy, submittedBy: entry.submittedBy,
  }));
  const open = rows.filter(row => ['CREATED','PENDING_SUBMISSION'].includes(row.status.toUpperCase()));
  const unknown = rows.filter(row => !['CREATED','PENDING_SUBMISSION','SUBMITTED','CANCELLED','CANCELED'].includes(row.status.toUpperCase()));
  const latestSubmitted = rows.find(row => row.status.toUpperCase() === 'SUBMITTED') ?? null;
  return { complete: complete && !unknown.length, openCount: open.length,
    openAmount: round2(open.reduce((sum,row) => sum + row.expectedAmount,0)),
    submittedToday: Boolean(latestSubmitted?.updatedAt && todayIstYmd(latestSubmitted.updatedAt) === today),
    latestSubmitted, rows };
}
