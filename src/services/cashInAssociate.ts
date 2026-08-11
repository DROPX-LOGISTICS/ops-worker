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
  CIA_REMITTANCE_FETCH_COUNT,
} from '../config';
import {
  addDaysYmd,
  daysBetweenYmd,
  getBusinessDayRange,
  REMITTANCE_LOOKBACK_DAYS,
  todayIstYmd,
  ymdFromIstEpochMs,
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
 * Cover the analysis window with locked ~15-day anchors (most recent first),
 * plus one prior chunk for carry-over deposits. Anchor count scales with the
 * requested range (e.g. ~3 for 31 days, ~7 for 90 days), capped for budget.
 */
export function getCiaRemittanceAnchors(fromDate: string, toDate: string): string[] {
  const step = REMITTANCE_LOOKBACK_DAYS - 1; // 15
  const spanDays = Math.max(1, daysBetweenYmd(fromDate, toDate) + 1);
  const needed = Math.min(8, Math.max(CIA_REMITTANCE_FETCH_COUNT, Math.ceil(spanDays / step) + 1));
  const anchors: string[] = [];
  let anchor = toDate;
  for (let i = 0; i < needed; i++) {
    const clamped = anchor < fromDate ? fromDate : anchor;
    if (!anchors.includes(clamped)) anchors.push(clamped);
    if (clamped <= fromDate && i > 0) break;
    anchor = addDaysYmd(anchor, -step);
  }
  return anchors;
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

function emptySummary(
  limitedByRemittanceWindow = false,
  alignedFromDate = '',
): CiaStationSummary {
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
    alignedFromDate,
  };
}

/**
 * Align gap/ageing start to the deposit cycle.
 * - If fromDate-1 has a CREATED/SUBMITTED deposit → window starts clean → use fromDate.
 * - Else use the last deposit date before fromDate (stations that deposit on
 *   different days than they hold cash). Fall back to fromDate when none found.
 */
export function resolveAlignedFromDate(
  fromDate: string,
  activeRemittances: RemittanceEntry[],
  startHourIst: number,
): string {
  const dayBefore = addDaysYmd(fromDate, -1);
  const dayBeforeRange = getBusinessDayRange(dayBefore, startHourIst);
  const hasDepositDayBefore = activeRemittances.some(
    (r) =>
      r.creationDate >= dayBeforeRange.startTime && r.creationDate <= dayBeforeRange.endTime,
  );
  if (hasDepositDayBefore) return fromDate;

  const fromStart = getBusinessDayRange(fromDate, startHourIst).startTime;
  let lastDepositYmd: string | null = null;
  for (const r of activeRemittances) {
    if (r.creationDate >= fromStart) continue;
    const ymd = ymdFromIstEpochMs(r.creationDate);
    if (!lastDepositYmd || ymd > lastDepositYmd) lastDepositYmd = ymd;
  }
  // Ageing + gap start on the deposit day itself (user: "from that day to toDate").
  return lastDepositYmd ?? fromDate;
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
 * Reconcile Cash In Associate ageing for a station over the analysis window.
 * Remittances: multiple ~15-day portal fetches to cover the window + prior deposits.
 *
 * Gap alignment: if the day before fromDate has no deposit, shift ageing + deposit
 * comparison to start at the last prior deposit date so held cash and deposits
 * share the same cycle (avoids false negatives like deposits >> open ageing).
 * difference = ageingTotal - depositedTotal on the aligned window.
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

  // Fetch remittances first (including a lookback before fromDate) so we can
  // align the ageing window to the last deposit cycle when needed.
  const remittanceLookupFrom = addDaysYmd(fromDate, -(REMITTANCE_LOOKBACK_DAYS - 1));
  const remittanceAnchors = getCiaRemittanceAnchors(remittanceLookupFrom, toDate);
  const remittanceBatches = await Promise.all(
    remittanceAnchors.map((anchor) =>
      fetchRemittancesAtAnchor(provider, stationCode, anchor, startHourIst, auth),
    ),
  );

  const allRemittances = dedupeRemittances(remittanceBatches.flat());
  const active = allRemittances.filter((r) => {
    const s = (r.status ?? '').toUpperCase();
    return s === 'CREATED' || s === 'SUBMITTED';
  });

  const alignedFrom = resolveAlignedFromDate(fromDate, active, startHourIst);

  const packagesRaw = await provider.getAgeingDrillDownData(
    stationCode,
    alignedFrom,
    auth,
    toDate,
    CIA_AGEING_STATUSES,
  );
  const ciaPackages = filterCashInAssociatePackages(packagesRaw);
  const cashAtStationPackages = filterCashAtStationPackages(packagesRaw);
  const ageingCashPackages = filterAgeingCashPackages(packagesRaw);

  const windowStart = getBusinessDayRange(alignedFrom, startHourIst).startTime;
  const windowEnd = getBusinessDayRange(toDate, startHourIst).endTime;
  const windowRemittances = active.filter(
    (r) => r.creationDate >= windowStart && r.creationDate <= windowEnd,
  );

  // Earliest portal start ≈ oldestAnchor - 15 days; flag if analysis starts before that.
  const oldestAnchor = remittanceAnchors[remittanceAnchors.length - 1] ?? toDate;
  const portalCoveredFrom = addDaysYmd(oldestAnchor, -(REMITTANCE_LOOKBACK_DAYS - 1));
  const limitedByRemittanceWindow = alignedFrom < portalCoveredFrom;

  // Subrequest budget: fetch details for the most recent remittances only.
  // Soft-fail: a single Amazon 500 on details must not fail the whole station.
  const detailsRemittances = [...windowRemittances]
    .sort((a, b) => b.creationDate - a.creationDate)
    .slice(0, CIA_REMITTANCE_DETAILS_MAX);

  const clearedByTracking = await buildClearedTrackingMap(
    detailsRemittances,
    provider,
    auth,
    CIA_REMITTANCE_DETAILS_CONCURRENCY,
    { softFail: true },
  );

  const ledger = buildLedgerDays({
    fromDate: alignedFrom,
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
    alignedFromDate: alignedFrom,
  };

  if (ciaPackages.length === 0 && windowRemittances.length === 0) {
    return {
      window: { from: alignedFrom, to: toDate },
      summary: emptySummary(limitedByRemittanceWindow, alignedFrom),
      ledger,
      pendingDrivers: [],
    };
  }

  return {
    window: { from: alignedFrom, to: toDate },
    summary,
    ledger,
    pendingDrivers,
  };
}
