import type {
  AgeingPackageDetail,
  DriverReconciliationEntry,
  Money,
  ReconBreakdownItem,
} from '../types';
import { ageingCalendarYmd, istTimestampFromEpochMs, parseAgeingUpdatedMs, todayIstYmd } from './dateRange';
import { round2 } from './number';

/** Ageing package state → recon classification for the requested date. */
export type ReconStateClass = 'pending' | 'completed' | 'other';

export interface AgeingReconTotals {
  pending: number;
  completed: number;
  sameDayPending: number;
  priorPending: number;
}

export interface EnrichReconciliationResult {
  entries: DriverReconciliationEntry[];
  /** Prior-day Cash In Associate — cash sheet lock / warning. */
  pendingReconTotal: number;
  /** Today's Cash In Associate — driver validation only, not a cash-sheet lock. */
  sameDayPendingReconTotal: number;
  completedReconTotal: number;
}

interface DriverAgeingBuckets {
  pending: number;
  completed: number;
  sameDayPending: number;
  priorPending: number;
  priorBreakdown: ReconBreakdownItem[];
  sameDayBreakdown: ReconBreakdownItem[];
}

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

/** Ageing money fields are often in paise (e.g. 284723.0 → 2847.23). */
function toRupees(amount: number): number {
  return round2(amount / 100);
}

function emptyBuckets(): DriverAgeingBuckets {
  return {
    pending: 0,
    completed: 0,
    sameDayPending: 0,
    priorPending: 0,
    priorBreakdown: [],
    sameDayBreakdown: [],
  };
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

function breakdownFromPackage(pkg: AgeingPackageDetail): ReconBreakdownItem {
  const ms = parseAgeingUpdatedMs(pkg.lastUpdatedTime);
  return {
    trackingId: pkg.trackingId,
    paymentMethod: (pkg.actualPaymentMethod ?? pkg.paymentMethod ?? 'CASH').trim() || 'CASH',
    amount: { unit: 'INR', value: toRupees(pkg.receivableAmount) },
    stationTimeZone: 'IST',
    ...(ms != null ? { moneyCollectionTime: ms } : {}),
  };
}

function isSameDayPackage(pkg: AgeingPackageDetail, todayYmd: string): boolean {
  const day = ageingCalendarYmd(pkg.lastUpdatedTime);
  return Boolean(day && day === todayYmd);
}

/**
 * Sum CASH ageing receivable amounts by driverId (tasId) into pending vs completed.
 * Unassigned packages (no driverId) are keyed as `__unassigned__`.
 * Same-calendar-day CIA is split out so the cash sheet does not lock today's count.
 */
export function sumAgeingReconByDriver(
  packages: AgeingPackageDetail[],
  todayYmd = todayIstYmd(),
): Map<string, DriverAgeingBuckets> {
  const byDriver = new Map<string, DriverAgeingBuckets>();

  for (const pkg of packages) {
    if (!isCashMethod(pkg.actualPaymentMethod)) continue;
    const kind = classifyReconState(pkg.state);
    if (kind === 'other') continue;

    const driverKey = (pkg.driverId ?? '').trim() || '__unassigned__';
    let totals = byDriver.get(driverKey);
    if (!totals) {
      totals = emptyBuckets();
      byDriver.set(driverKey, totals);
    }

    const amount = toRupees(pkg.receivableAmount);
    if (kind === 'completed') {
      totals.completed = round2(totals.completed + amount);
      continue;
    }

    totals.pending = round2(totals.pending + amount);
    const item = breakdownFromPackage(pkg);
    if (isSameDayPackage(pkg, todayYmd)) {
      totals.sameDayPending = round2(totals.sameDayPending + amount);
      totals.sameDayBreakdown.push(item);
    } else {
      totals.priorPending = round2(totals.priorPending + amount);
      totals.priorBreakdown.push(item);
    }
  }

  return byDriver;
}

/**
 * Cash tracking IDs Amazon's driver reconciliation still has pending for this business
 * day that the ageing feed never returns (e.g. alphanumeric access-point IDs like
 * `AP737146364416`, which do not show up in ageing or search). Without these the
 * driver's expected cash is lower than recon pending by exactly those amounts.
 *
 * Returned as synthetic Cash In Associate ageing rows (amount in paise, like the feed),
 * keyed to the reconciling driver, so they flow through expected cash and pending recon
 * exactly like a normal ageing row. Items outside `range` (earlier days' pending, which
 * overallPendingRecon is cumulative over) and any ID in `excludeIds` are skipped.
 */
export function reconOnlyCashPackages(
  entries: DriverReconciliationEntry[],
  range: { startTime: number; endTime: number },
  excludeIds: Set<string>,
): AgeingPackageDetail[] {
  const out: AgeingPackageDetail[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const driverId = (entry.driverInfo?.id ?? '').trim() || null;
    for (const item of entry.paymentInfo?.overallPendingReconBreakdownList ?? []) {
      const trackingId = (item.trackingId ?? '').trim();
      if (!trackingId || excludeIds.has(trackingId) || seen.has(trackingId)) continue;
      if (!isCashMethod(item.paymentMethod)) continue;
      const at = Number(item.moneyCollectionTime);
      if (!Number.isFinite(at) || at < range.startTime || at > range.endTime) continue;
      const amount = Number(item.amount?.value ?? 0);
      if (!(amount > 0)) continue;
      seen.add(trackingId);
      out.push({
        trackingId,
        driverId,
        paymentMethod: 'CASH',
        actualPaymentMethod: 'CASH',
        receivableAmount: Math.round(amount * 100),
        orderAmount: Math.round(amount * 100),
        state: 'Cash In Associate',
        reason: 'RECON_ONLY',
        packageType: null,
        lastUpdatedTime: istTimestampFromEpochMs(at),
        orderingOrderId: null,
        stationCode: null,
        dspName: null,
        accessPointId: null,
      });
    }
  }
  return out;
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
 *
 * Same-day Cash In Associate is the cash being counted now. It must not lock
 * denominations on the cash sheet (`overallPendingRecon`). It stays on
 * `sameDayPendingRecon` for Driver validation.
 */
export function enrichReconciliationWithAgeing(
  entries: DriverReconciliationEntry[],
  packages: AgeingPackageDetail[],
  options?: { todayYmd?: string },
): EnrichReconciliationResult {
  const todayYmd = options?.todayYmd ?? todayIstYmd();
  const byDriver = sumAgeingReconByDriver(packages, todayYmd);

  let pendingReconTotal = 0;
  let sameDayPendingReconTotal = 0;
  let completedReconTotal = 0;
  for (const totals of byDriver.values()) {
    pendingReconTotal = round2(pendingReconTotal + totals.priorPending);
    sameDayPendingReconTotal = round2(sameDayPendingReconTotal + totals.sameDayPending);
    completedReconTotal = round2(completedReconTotal + totals.completed);
  }

  const enriched: DriverReconciliationEntry[] = entries.map((entry) => {
    const tasId = (entry.driverInfo?.id ?? '').trim();
    const totals = (tasId && byDriver.get(tasId)) || emptyBuckets();

    return {
      ...entry,
      pendingReconAmount: totals.priorPending,
      sameDayPendingReconAmount: totals.sameDayPending,
      completedReconAmount: totals.completed,
      paymentInfo: {
        ...entry.paymentInfo,
        overallPendingRecon: moneyWithValue(
          entry.paymentInfo?.overallPendingRecon,
          totals.priorPending,
        ),
        sameDayPendingRecon: moneyWithValue(
          entry.paymentInfo?.sameDayPendingRecon,
          totals.sameDayPending,
        ),
        overallPendingReconBreakdownList: totals.priorBreakdown,
        sameDayPendingReconBreakdownList: totals.sameDayBreakdown,
      },
    };
  });

  return {
    entries: enriched,
    pendingReconTotal,
    sameDayPendingReconTotal,
    completedReconTotal,
  };
}
