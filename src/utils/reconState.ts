import type {
  AgeingPackageDetail,
  DriverReconciliationEntry,
  Money,
} from '../types';
import { round2 } from './number';

/** Ageing package state → recon classification for the requested date. */
export type ReconStateClass = 'pending' | 'completed' | 'other';

export interface AgeingReconTotals {
  pending: number;
  completed: number;
}

export interface EnrichReconciliationResult {
  entries: DriverReconciliationEntry[];
  pendingReconTotal: number;
  completedReconTotal: number;
}

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

/** Ageing money fields are often in paise (e.g. 284723.0 → 2847.23). */
function toRupees(amount: number): number {
  return round2(amount / 100);
}

/**
 * Normalize ageing `state` for comparison:
 * trim → upper-case → spaces/underscores collapsed to a single underscore.
 */
export function normalizeReconState(state: string | null | undefined): string {
  return (state ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '_');
}

/**
 * Classify ageing `state`:
 * - Cash In Associate / Cash With Associate → pending recon
 * - CASH_AT_STATION / Cash At Station → completed recon
 * - delivered / anything else → other (not pending or completed)
 */
export function classifyReconState(state: string | null | undefined): ReconStateClass {
  const key = normalizeReconState(state);
  if (key === 'CASH_IN_ASSOCIATE' || key === 'CASH_WITH_ASSOCIATE') return 'pending';
  if (key === 'CASH_AT_STATION') return 'completed';
  return 'other';
}

/**
 * Sum CASH ageing receivable amounts by driverId (tasId) into pending vs completed.
 * Unassigned packages (no driverId) are keyed as `__unassigned__`.
 */
export function sumAgeingReconByDriver(
  packages: AgeingPackageDetail[],
): Map<string, AgeingReconTotals> {
  const byDriver = new Map<string, AgeingReconTotals>();

  for (const pkg of packages) {
    if (!isCashMethod(pkg.actualPaymentMethod)) continue;
    const kind = classifyReconState(pkg.state);
    if (kind === 'other') continue;

    const driverKey = (pkg.driverId ?? '').trim() || '__unassigned__';
    let totals = byDriver.get(driverKey);
    if (!totals) {
      totals = { pending: 0, completed: 0 };
      byDriver.set(driverKey, totals);
    }

    const amount = toRupees(pkg.receivableAmount);
    if (kind === 'pending') totals.pending = round2(totals.pending + amount);
    else totals.completed = round2(totals.completed + amount);
  }

  return byDriver;
}

function moneyWithValue(existing: Money | undefined, value: number): Money {
  return {
    unit: existing?.unit ?? 'INR',
    value: round2(value),
  };
}

/**
 * Override Amazon `overallPendingRecon` with date-scoped ageing state totals.
 *
 * Amazon's pending recon is cumulative/current; ageing for the requested
 * calendar day is the source of truth for historical requests.
 */
export function enrichReconciliationWithAgeing(
  entries: DriverReconciliationEntry[],
  packages: AgeingPackageDetail[],
): EnrichReconciliationResult {
  const byDriver = sumAgeingReconByDriver(packages);

  let pendingReconTotal = 0;
  let completedReconTotal = 0;
  for (const totals of byDriver.values()) {
    pendingReconTotal = round2(pendingReconTotal + totals.pending);
    completedReconTotal = round2(completedReconTotal + totals.completed);
  }

  const enriched: DriverReconciliationEntry[] = entries.map((entry) => {
    const tasId = (entry.driverInfo?.id ?? '').trim();
    const totals = (tasId && byDriver.get(tasId)) || { pending: 0, completed: 0 };

    return {
      ...entry,
      pendingReconAmount: totals.pending,
      completedReconAmount: totals.completed,
      paymentInfo: {
        ...entry.paymentInfo,
        overallPendingRecon: moneyWithValue(
          entry.paymentInfo?.overallPendingRecon,
          totals.pending,
        ),
        // Amazon breakdown is not date-scoped; clear so it cannot contradict.
        overallPendingReconBreakdownList: [],
      },
    };
  });

  return {
    entries: enriched,
    pendingReconTotal,
    completedReconTotal,
  };
}
