import type {
  StationDataProvider,
  AgeingStatusSelector,
} from '../providers/StationDataProvider';
import type {
  AgeingPackageDetail,
  AmazonAuthContext,
  CiaPendingDriver,
  CiaStationPayload,
  CiaStationSummary,
  RemittanceEntry,
  RemittanceLedgerShipment,
  WorkforceAssociate,
} from '../types';
import {
  CIA_LOOKBACK_DAYS,
  CIA_REMITTANCE_DETAILS_CONCURRENCY,
  CIA_REMITTANCE_DETAILS_MAX,
} from '../config';
import {
  addDaysYmd,
  getBusinessDayRange,
  REMITTANCE_LOOKBACK_DAYS,
  todayIstYmd,
} from '../utils/dateRange';
import { classifyReconState } from '../utils/reconState';
import { round2 } from '../utils/number';
import {
  buildClearedTrackingMap,
  buildLedgerDays,
  sumRemittanceCash,
} from './remittancePending';

/**
 * Ageing buckets for CIA + Cash At Station cash.
 * CIA rows also appear under Received → DS -> Customer.
 */
export const CIA_AGEING_STATUSES: AgeingStatusSelector[] = [
  'Cash With Associate',
  'Cash At Station',
  { status: 'Received', values: ['DS -> Customer'] },
];

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

/** Ageing money fields are often in paise. */
function toRupees(amount: number): number {
  return round2(amount / 100);
}

function sumCashPackageRupees(packages: AgeingPackageDetail[]): number {
  return round2(packages.reduce((s, p) => s + toRupees(p.receivableAmount), 0));
}

/** Yesterday IST back through CIA_LOOKBACK_DAYS (excludes today). */
export function getCiaAnalysisWindow(nowMs = Date.now()): {
  asOfDate: string;
  fromDate: string;
  toDate: string;
} {
  const today = todayIstYmd(nowMs);
  const toDate = addDaysYmd(today, -1);
  const fromDate = addDaysYmd(toDate, -(CIA_LOOKBACK_DAYS - 1));
  return { asOfDate: toDate, fromDate, toDate };
}

/**
 * Amazon bank-deposits portal only returns ~16 days ending at the selected date.
 * Cover a ~31-day analysis window with two locked anchors:
 *   recent: end = toDate          → later half of the window
 *   earlier: end = toDate - 15    → earlier half of the window
 */
export function getCiaRemittanceAnchors(fromDate: string, toDate: string): {
  recentAnchor: string;
  earlierAnchor: string;
} {
  const recentAnchor = toDate;
  const earlierAnchor = addDaysYmd(toDate, -(REMITTANCE_LOOKBACK_DAYS - 1));
  return {
    recentAnchor,
    earlierAnchor: earlierAnchor < fromDate ? fromDate : earlierAnchor,
  };
}

function dedupeRemittances(rows: RemittanceEntry[]): RemittanceEntry[] {
  const byId = new Map<string, RemittanceEntry>();
  for (const r of rows) {
    const id = (r.remittanceId ?? '').trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, r);
  }
  return [...byId.values()];
}

/** Keep CASH packages whose ageing state is Cash In / With Associate. */
export function filterCashInAssociatePackages(
  packages: AgeingPackageDetail[],
): AgeingPackageDetail[] {
  return packages.filter(
    (p) => isCashMethod(p.actualPaymentMethod) && classifyReconState(p.state) === 'pending',
  );
}

/** Keep CASH packages in Cash At Station. */
export function filterCashAtStationPackages(
  packages: AgeingPackageDetail[],
): AgeingPackageDetail[] {
  return packages.filter(
    (p) => isCashMethod(p.actualPaymentMethod) && classifyReconState(p.state) === 'completed',
  );
}

/** CASH + (Cash In Associate OR Cash At Station). */
export function filterAgeingCashPackages(
  packages: AgeingPackageDetail[],
): AgeingPackageDetail[] {
  return packages.filter((p) => {
    if (!isCashMethod(p.actualPaymentMethod)) return false;
    const kind = classifyReconState(p.state);
    return kind === 'pending' || kind === 'completed';
  });
}

function emptySummary(limitedByRemittanceWindow = false): CiaStationSummary {
  return {
    ciaTotal: 0,
    cashAtStationTotal: 0,
    ageingTotal: 0,
    depositedTotal: 0,
    pendingLiability: 0,
    clearedInWindow: 0,
    cashDifference: 0,
    difference: 0,
    shipmentCount: 0,
    pendingDriverCount: 0,
    limitedByRemittanceWindow,
  };
}

function buildPendingDrivers(
  ledger: ReturnType<typeof buildLedgerDays>,
  workforceByTransporterId?: Map<string, WorkforceAssociate>,
): CiaPendingDriver[] {
  type Acc = {
    driverName: string;
    tasId: string | null;
    employeeId: number | null;
    operationalStatus: string | null;
    mappedFromWorkforce?: boolean;
    amount: number;
    shipmentCount: number;
    dateSet: Set<string>;
    shipments: RemittanceLedgerShipment[];
  };

  const byKey = new Map<string, Acc>();

  for (const day of ledger) {
    for (const d of day.drivers) {
      const pendingShipments = d.shipments.filter((s) => s.status === 'pending');
      if (pendingShipments.length === 0) continue;

      const key = d.tasId ?? d.driverName;
      let acc = byKey.get(key);
      if (!acc) {
        const wf = d.tasId ? workforceByTransporterId?.get(d.tasId) : undefined;
        acc = {
          driverName: d.driverName,
          tasId: d.tasId,
          employeeId: d.employeeId,
          operationalStatus: wf?.operationalStatus ?? null,
          mappedFromWorkforce: d.mappedFromWorkforce,
          amount: 0,
          shipmentCount: 0,
          dateSet: new Set(),
          shipments: [],
        };
        byKey.set(key, acc);
      }

      for (const s of pendingShipments) {
        acc.shipments.push(s);
        acc.amount = round2(acc.amount + s.pendingAmount);
        acc.shipmentCount += 1;
        acc.dateSet.add(s.keptOnDate);
      }
    }
  }

  return [...byKey.values()]
    .map((a) => ({
      driverName: a.driverName,
      tasId: a.tasId,
      employeeId: a.employeeId,
      operationalStatus: a.operationalStatus,
      mappedFromWorkforce: a.mappedFromWorkforce,
      amount: a.amount,
      shipmentCount: a.shipmentCount,
      dates: [...a.dateSet].sort(),
      shipments: a.shipments.sort((x, y) => x.keptOnDate.localeCompare(y.keptOnDate)),
    }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Fetch bank deposits for a portal anchor date (locked — does not extend to today).
 */
async function fetchRemittancesAtAnchor(
  provider: StationDataProvider,
  stationCode: string,
  anchorYmd: string,
  startHourIst: number,
  auth: AmazonAuthContext,
): Promise<RemittanceEntry[]> {
  const range = getBusinessDayRange(anchorYmd, startHourIst);
  return provider.getRemittances(stationCode, range, auth, { lockPortalEndToRange: true });
}

/**
 * Reconcile Cash In Associate ageing for a station over the 31-day prior window.
 * Remittances: two ~15-day portal fetches (recent + earlier) to cover the full window.
 * difference = ageingTotal - depositedTotal.
 */
export async function reconcileCashInAssociate(args: {
  stationCode: string;
  fromDate: string;
  toDate: string;
  startHourIst: number;
  provider: StationDataProvider;
  auth: AmazonAuthContext;
  workforceByTransporterId?: Map<string, WorkforceAssociate>;
}): Promise<CiaStationPayload> {
  const {
    stationCode,
    fromDate,
    toDate,
    startHourIst,
    provider,
    auth,
    workforceByTransporterId,
  } = args;

  const packagesRaw = await provider.getAgeingDrillDownData(
    stationCode,
    fromDate,
    auth,
    toDate,
    CIA_AGEING_STATUSES,
  );
  const ciaPackages = filterCashInAssociatePackages(packagesRaw);
  const cashAtStationPackages = filterCashAtStationPackages(packagesRaw);
  const ageingCashPackages = filterAgeingCashPackages(packagesRaw);

  const { recentAnchor, earlierAnchor } = getCiaRemittanceAnchors(fromDate, toDate);

  // Two portal fetches in parallel — skip duplicate when anchors collapse.
  const remittanceBatches =
    earlierAnchor === recentAnchor
      ? [await fetchRemittancesAtAnchor(provider, stationCode, recentAnchor, startHourIst, auth)]
      : await Promise.all([
          fetchRemittancesAtAnchor(provider, stationCode, recentAnchor, startHourIst, auth),
          fetchRemittancesAtAnchor(provider, stationCode, earlierAnchor, startHourIst, auth),
        ]);

  const allRemittances = dedupeRemittances(remittanceBatches.flat());
  const active = allRemittances.filter((r) => {
    const s = (r.status ?? '').toUpperCase();
    return s === 'CREATED' || s === 'SUBMITTED';
  });

  const windowStart = getBusinessDayRange(fromDate, startHourIst).startTime;
  const windowEnd = getBusinessDayRange(toDate, startHourIst).endTime;
  const windowRemittances = active.filter(
    (r) => r.creationDate >= windowStart && r.creationDate <= windowEnd,
  );

  // Earlier portal start ≈ earlierAnchor - 15 days; flag if analysis starts before that.
  const portalCoveredFrom = addDaysYmd(earlierAnchor, -(REMITTANCE_LOOKBACK_DAYS - 1));
  const limitedByRemittanceWindow = fromDate < portalCoveredFrom;

  // Subrequest budget: fetch details for the most recent remittances only.
  const detailsRemittances = [...windowRemittances]
    .sort((a, b) => b.creationDate - a.creationDate)
    .slice(0, CIA_REMITTANCE_DETAILS_MAX);

  const clearedByTracking = await buildClearedTrackingMap(
    detailsRemittances,
    provider,
    auth,
    CIA_REMITTANCE_DETAILS_CONCURRENCY,
  );

  const ledger = buildLedgerDays({
    fromDate,
    toDate,
    drivers: [],
    packages: ciaPackages,
    windowRemittances,
    clearedByTracking,
    workforceByTransporterId,
  });

  const ciaTotal = round2(ledger.reduce((s, d) => s + d.expectedCashTotal, 0));
  const cashAtStationTotal = sumCashPackageRupees(cashAtStationPackages);
  // All CASH ageing in CIA + Cash At Station (not CIA-only).
  const ageingTotal = sumCashPackageRupees(ageingCashPackages);
  const depositedTotal = sumRemittanceCash(windowRemittances);
  const pendingLiability = round2(ledger.reduce((s, d) => s + d.stillPendingAmount, 0));
  const clearedInWindow = round2(
    ledger.reduce((s, d) => s + d.clearedSameDayAmount + d.forwardedAmount, 0),
  );
  const shipmentCount = ageingCashPackages.length;
  const pendingDrivers = buildPendingDrivers(ledger, workforceByTransporterId);
  const cashDifference = round2(ageingTotal - depositedTotal);

  const summary: CiaStationSummary = {
    ciaTotal,
    cashAtStationTotal,
    ageingTotal,
    depositedTotal,
    pendingLiability,
    clearedInWindow,
    cashDifference,
    difference: cashDifference,
    shipmentCount,
    pendingDriverCount: pendingDrivers.length,
    limitedByRemittanceWindow,
  };

  if (ciaPackages.length === 0 && windowRemittances.length === 0) {
    return {
      window: { from: fromDate, to: toDate },
      summary: emptySummary(limitedByRemittanceWindow),
      ledger,
      pendingDrivers: [],
    };
  }

  return {
    window: { from: fromDate, to: toDate },
    summary,
    ledger,
    pendingDrivers,
  };
}
