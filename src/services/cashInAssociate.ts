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
  CIA_REFRESH_CHUNK_DAYS,
  CIA_REMITTANCE_DETAILS_CONCURRENCY,
  CIA_REMITTANCE_DETAILS_MAX,
  CIA_REMITTANCE_FETCH_COUNT,
} from '../config';
import {
  addDaysYmd,
  ageingCalendarYmd,
  businessYmdFromEpochMs,
  daysBetweenYmd,
  getBusinessDayRange,
  REMITTANCE_LOOKBACK_DAYS,
  todayIstYmd,
} from '../utils/dateRange';
import { classifyReconState, normalizeReconState } from '../utils/reconState';
import { round2 } from '../utils/number';
import {
  buildClearedTrackingMap,
  buildLedgerDays,
  sumRemittanceCash,
} from './remittancePending';

/**
 * Excel / Amazon ageing pivot for CIA gap:
 * - Cash With Associate + Cash At Station (main)
 * - Delivered is fetched only so rare TR_CANCELLED CASH rows (e.g. ₹206) match
 *   Excel; normal Delivered CASH is excluded in filterAgeingCashPackages.
 * Do NOT add Received → DS->Customer.
 */
export const CIA_AGEING_STATUSES: AgeingStatusSelector[] = [
  'Cash With Associate',
  'Cash At Station',
  'Delivered',
];

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

/** Prefer actualPaymentMethod; fall back to paymentMethod (Excel export uses both). */
function isCashPackage(pkg: AgeingPackageDetail): boolean {
  return isCashMethod(pkg.actualPaymentMethod) || isCashMethod(pkg.paymentMethod);
}

function normalizeReason(reason: string | null | undefined): string {
  return (reason ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Delivered CASH that still appears on Excel ageing cash pivots.
 * Normal successful Delivered rows must not inflate ageingTotal.
 */
function isExcelDeliveredCashEdge(pkg: AgeingPackageDetail): boolean {
  if (normalizeReconState(pkg.state) !== 'DELIVERED') return false;
  return normalizeReason(pkg.reason) === 'TR_CANCELLED';
}

/** Ageing money fields are often in paise. */
function toRupees(amount: number): number {
  return round2(amount / 100);
}

function sumCashPackageRupees(packages: AgeingPackageDetail[]): number {
  return round2(packages.reduce((s, p) => s + toRupees(p.receivableAmount), 0));
}

/** Per-day CASH receivable (CIA + CAS) — matches Excel calendar-day pivot. */
function cashReceivableByCalendarDay(packages: AgeingPackageDetail[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const pkg of packages) {
    const day = ageingCalendarYmd(pkg.lastUpdatedTime);
    if (!day) continue;
    byDay.set(day, round2((byDay.get(day) ?? 0) + toRupees(pkg.receivableAmount)));
  }
  return byDay;
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

/** Inclusive YYYY-MM-DD slices of at most `chunkDays` calendar days. */
export function splitYmdRange(
  fromDate: string,
  toDate: string,
  chunkDays = CIA_REFRESH_CHUNK_DAYS,
): Array<{ from: string; to: string }> {
  if (toDate < fromDate) return [];
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const chunkTo = addDaysYmd(cursor, chunkDays - 1);
    const to = chunkTo < toDate ? chunkTo : toDate;
    chunks.push({ from: cursor, to });
    cursor = addDaysYmd(to, 1);
  }
  return chunks;
}

function driverMergeKey(d: CiaPendingDriver): string {
  const tas = String(d.tasId ?? '').trim().toUpperCase();
  if (tas) return `tas:${tas}`;
  const emp = String(d.employeeId ?? '').trim().toUpperCase();
  if (emp) return `emp:${emp}`;
  return `name:${String(d.driverName ?? '').trim().toLowerCase()}`;
}

/**
 * Merge live-range CIA payloads from contiguous date chunks into one snapshot.
 * Totals are summed; drivers/shipments deduped by tracking id.
 */
export function mergeCiaStationPayloads(
  parts: CiaStationPayload[],
  window: { from: string; to: string },
): CiaStationPayload {
  if (parts.length === 0) {
    return {
      window,
      summary: emptySummary(false, window.from),
      ledger: [],
      pendingDrivers: [],
    };
  }
  if (parts.length === 1) {
    const only = parts[0]!;
    return {
      ...only,
      window: { from: window.from, to: window.to },
      summary: {
        ...only.summary,
        alignedFromDate: only.summary.alignedFromDate || window.from,
        cashDifference: round2(only.summary.ageingTotal - only.summary.depositedTotal),
        difference: round2(only.summary.ageingTotal - only.summary.depositedTotal),
      },
    };
  }

  const ledgerByDate = new Map<string, (typeof parts)[0]['ledger'][number]>();
  for (const part of parts) {
    for (const day of part.ledger ?? []) {
      if (!ledgerByDate.has(day.date)) ledgerByDate.set(day.date, day);
    }
  }

  const drivers = new Map<
    string,
    CiaPendingDriver & { dateSet: Set<string>; shipmentByTracking: Map<string, CiaPendingDriver['shipments'][number]> }
  >();
  for (const part of parts) {
    for (const d of part.pendingDrivers ?? []) {
      const key = driverMergeKey(d);
      let acc = drivers.get(key);
      if (!acc) {
        acc = {
          driverName: d.driverName,
          tasId: d.tasId,
          employeeId: d.employeeId,
          operationalStatus: d.operationalStatus,
          mappedFromWorkforce: d.mappedFromWorkforce,
          amount: 0,
          shipmentCount: 0,
          dates: [],
          shipments: [],
          dateSet: new Set<string>(),
          shipmentByTracking: new Map(),
        };
        drivers.set(key, acc);
      }
      for (const s of d.shipments ?? []) {
        const tid = (s.trackingId ?? '').trim();
        if (!tid || acc.shipmentByTracking.has(tid)) continue;
        acc.shipmentByTracking.set(tid, s);
        if (s.keptOnDate) acc.dateSet.add(s.keptOnDate);
      }
    }
  }

  const pendingDrivers = [...drivers.values()]
    .map((a) => {
      const shipments = [...a.shipmentByTracking.values()].sort((x, y) =>
        (x.keptOnDate ?? '').localeCompare(y.keptOnDate ?? ''),
      );
      const amount = round2(shipments.reduce((s, row) => s + (row.pendingAmount ?? 0), 0));
      return {
        driverName: a.driverName,
        tasId: a.tasId,
        employeeId: a.employeeId,
        operationalStatus: a.operationalStatus,
        mappedFromWorkforce: a.mappedFromWorkforce,
        amount,
        shipmentCount: shipments.length,
        dates: [...a.dateSet].sort(),
        shipments,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const ciaTotal = round2(parts.reduce((s, p) => s + (p.summary.ciaTotal ?? 0), 0));
  const cashAtStationTotal = round2(
    parts.reduce((s, p) => s + (p.summary.cashAtStationTotal ?? 0), 0),
  );
  const ageingTotal = round2(parts.reduce((s, p) => s + (p.summary.ageingTotal ?? 0), 0));
  const depositedTotal = round2(parts.reduce((s, p) => s + (p.summary.depositedTotal ?? 0), 0));
  const pendingLiability = round2(
    parts.reduce((s, p) => s + (p.summary.pendingLiability ?? 0), 0),
  );
  const clearedInWindow = round2(
    parts.reduce((s, p) => s + (p.summary.clearedInWindow ?? 0), 0),
  );
  const shipmentCount = parts.reduce((s, p) => s + (p.summary.shipmentCount ?? 0), 0);
  const limitedByRemittanceWindow = parts.some((p) => p.summary.limitedByRemittanceWindow);
  const alignedDates = parts
    .map((p) => p.summary.alignedFromDate)
    .filter(Boolean)
    .sort();
  const cashDifference = round2(ageingTotal - depositedTotal);

  return {
    window: { from: window.from, to: window.to },
    summary: {
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
      alignedFromDate: alignedDates[0] ?? window.from,
    },
    ledger: [...ledgerByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    pendingDrivers,
  };
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
    (p) => isCashPackage(p) && classifyReconState(p.state) === 'pending',
  );
}

/** Keep CASH packages in Cash At Station. */
export function filterCashAtStationPackages(
  packages: AgeingPackageDetail[],
): AgeingPackageDetail[] {
  return packages.filter(
    (p) => isCashPackage(p) && classifyReconState(p.state) === 'completed',
  );
}

/**
 * Excel cash ageing total: CIA + Cash At Station CASH, plus rare Delivered
 * TR_CANCELLED CASH (successful Delivered CASH is excluded).
 */
export function filterAgeingCashPackages(
  packages: AgeingPackageDetail[],
): AgeingPackageDetail[] {
  return packages.filter((p) => {
    if (!isCashPackage(p)) return false;
    const kind = classifyReconState(p.state);
    if (kind === 'pending' || kind === 'completed') return true;
    return isExcelDeliveredCashEdge(p);
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
    const ymd = businessYmdFromEpochMs(r.creationDate, startHourIst);
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
 * Gap alignment (when enabled): if the day before fromDate has no deposit, shift
 * ageing + deposit comparison to the last prior deposit date so held cash and
 * deposits share the same cycle. Disable for explicit live date-range checks
 * that must match an Excel export window exactly.
 * difference = ageingTotal - depositedTotal on the (aligned) window.
 */
export async function reconcileCashInAssociate(args: {
  stationCode: string;
  fromDate: string;
  toDate: string;
  startHourIst: number;
  provider: StationDataProvider;
  auth: AmazonAuthContext;
  workforceByTransporterId?: Map<string, WorkforceAssociate>;
  /** Default true. Set false for live fromDate/toDate Excel-style checks. */
  alignDepositCycle?: boolean;
  /**
   * Fetch getRemittanceDetailsForExcel for cleared-in-window tracking.
   * Default true for nightly snapshots. Disable for interactive live/range
   * calls — those details are the main CF Worker subrequest/CPU blow-up.
   */
  includeRemittanceDetails?: boolean;
}): Promise<CiaStationPayload> {
  const {
    stationCode,
    fromDate,
    toDate,
    startHourIst,
    provider,
    auth,
    workforceByTransporterId,
    alignDepositCycle = true,
    includeRemittanceDetails = true,
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

  const alignedFrom = alignDepositCycle
    ? resolveAlignedFromDate(fromDate, active, startHourIst)
    : fromDate;

  const packagesRaw = await provider.getAgeingDrillDownData(
    stationCode,
    alignedFrom,
    auth,
    toDate,
    CIA_AGEING_STATUSES,
    startHourIst,
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
  // Live/range UI skips this — ageing totals + deposit sums still match Excel.
  let clearedByTracking: Awaited<ReturnType<typeof buildClearedTrackingMap>> = new Map();
  if (includeRemittanceDetails) {
    const detailsRemittances = [...windowRemittances]
      .sort((a, b) => b.creationDate - a.creationDate)
      .slice(0, CIA_REMITTANCE_DETAILS_MAX);

    clearedByTracking = await buildClearedTrackingMap(
      detailsRemittances,
      provider,
      auth,
      CIA_REMITTANCE_DETAILS_CONCURRENCY,
      { softFail: true, startHourIst },
    );
  }

  const ledger = buildLedgerDays({
    fromDate: alignedFrom,
    toDate,
    drivers: [],
    packages: ciaPackages,
    windowRemittances,
    clearedByTracking,
    workforceByTransporterId,
    startHourIst,
  });

  // Ledger expected was CIA-only (near-zero most days). Overlay Excel-style
  // daily receivable = all CASH in CIA + Cash At Station for that calendar day.
  const receivableByDay = cashReceivableByCalendarDay(ageingCashPackages);
  for (const day of ledger) {
    day.expectedCashTotal = receivableByDay.get(day.date) ?? 0;
    day.shortAmount = round2(day.expectedCashTotal - day.remittanceTotalCash);
  }

  const ciaTotal = sumCashPackageRupees(ciaPackages);
  const cashAtStationTotal = sumCashPackageRupees(cashAtStationPackages);
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
