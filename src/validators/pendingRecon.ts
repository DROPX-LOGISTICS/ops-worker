import type { DriverReconciliationEntry } from '../types';
import { isZero, round2 } from '../utils/number';

export interface PendingReconFailure {
  driverName: string;
  driverId: string | null;
  pendingReconAmount: number;
  unit: string | null;
}

export interface PendingReconResult {
  passed: boolean;
  failures: PendingReconFailure[];
  totalPending: number;
}

/**
 * Step 1: every active driver at the station must have zero pending
 * reconciliation (overallPendingRecon) before a cash denomination can be
 * accepted — cash they're still holding hasn't been reconciled yet.
 */
export function checkPendingRecon(entries: DriverReconciliationEntry[]): PendingReconResult {
  const failures: PendingReconFailure[] = [];
  let totalPending = 0;

  for (const entry of entries) {
    const pending = entry.paymentInfo?.overallPendingRecon;
    const amount = pending?.value ?? 0;
    if (!isZero(amount)) {
      failures.push({
        driverName: entry.driverInfo?.name ?? 'UNKNOWN',
        driverId: entry.driverInfo?.id ?? null,
        pendingReconAmount: round2(amount),
        unit: pending?.unit ?? null,
      });
      totalPending += amount;
    }
  }

  return { passed: failures.length === 0, failures, totalPending: round2(totalPending) };
}
