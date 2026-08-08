import type { StationDataProvider } from '../providers/StationDataProvider';
import type {
  AmazonAuthContext,
  Driver,
  ExpectedCashSummary,
  RemittanceEntry,
  RemittanceLedgerDay,
  RemittanceLedgerDriver,
  RemittanceLedgerShipment,
  RemittanceLedgerSummary,
  RemittanceMatchMode,
  RemittanceMatchStatus,
  AgeingPackageDetail,
  WorkforceAssociate,
} from '../types';
import {
  AGEING_PENDING_LOOKBACK_DAYS,
  REMITTANCE_LOOKBACK_DAYS,
  addDaysYmd,
  daysBetweenYmd,
  getBusinessDayRange,
  maxYmd,
  minYmd,
  todayIstYmd,
  ymdFromIstEpochMs,
} from '../utils/dateRange';
import { buildExpectedCashFromAgeing } from '../utils/expectedCash';
import { approxEqual, round2 } from '../utils/number';
import { REMITTANCE_CASH_TOLERANCE } from '../config';

const ACTIVE_STATUSES = new Set(['CREATED', 'SUBMITTED']);

function cashMatches(a: number, b: number): boolean {
  return approxEqual(a, b, REMITTANCE_CASH_TOLERANCE);
}

function isActiveRemittance(r: RemittanceEntry): boolean {
  return ACTIVE_STATUSES.has((r.status ?? '').toUpperCase());
}

function sumRemittanceCash(rows: RemittanceEntry[]): number {
  return round2(rows.reduce((sum, r) => sum + (r.actualAmount?.value ?? 0), 0));
}

function eachYmdInclusive(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  let cur = fromYmd;
  while (cur <= toYmd) {
    out.push(cur);
    cur = addDaysYmd(cur, 1);
  }
  return out;
}

interface ClearedTracking {
  clearedOnDate: string;
  remittanceId: string;
  remittanceCode: string | null;
  amount: number;
}

export interface RemittanceLedgerResult {
  summary: RemittanceLedgerSummary;
  ledger: RemittanceLedgerDay[];
  /** Same-day remittances used for the request date (backward compatible). */
  analysisRemittances: RemittanceEntry[];
}

/**
 * Build trackingId → remittance clearance day from getRemittanceDetailsForExcel.
 * Exact trackingId only — first remittance win if duplicated.
 */
async function buildClearedTrackingMap(
  remittances: RemittanceEntry[],
  provider: StationDataProvider,
  auth: AmazonAuthContext,
): Promise<Map<string, ClearedTracking>> {
  const map = new Map<string, ClearedTracking>();
  const unique = [
    ...new Map(
      remittances
        .filter((r) => (r.remittanceId ?? '').trim())
        .map((r) => [r.remittanceId.trim(), r] as const),
    ).values(),
  ];

  const detailsList = await Promise.all(
    unique.map(async (r) => {
      const details = await provider.getRemittanceDetailsForExcel(r.remittanceId, auth);
      return { remittance: r, details };
    }),
  );

  for (const { remittance, details } of detailsList) {
    const clearedOnDate = ymdFromIstEpochMs(remittance.creationDate);
    for (const s of details.shipments) {
      const trackingId = (s.trackingId ?? '').trim();
      if (!trackingId || map.has(trackingId)) continue;
      map.set(trackingId, {
        clearedOnDate,
        remittanceId: remittance.remittanceId,
        remittanceCode: remittance.remittanceCode,
        amount: s.amount,
      });
    }
  }
  return map;
}

function resolveWindow(args: {
  requestDate: string;
  startHourIst: number;
  sameDayExpected: number;
  sameDayRemittance: number;
  allRemittances: RemittanceEntry[];
}): {
  fromDate: string;
  toDate: string;
  mode: RemittanceMatchMode;
  limitedByRemittanceWindow: boolean;
  windowRemittances: RemittanceEntry[];
} {
  const { requestDate, startHourIst, sameDayExpected, sameDayRemittance, allRemittances } = args;
  const dayRange = getBusinessDayRange(requestDate, startHourIst);
  const active = allRemittances.filter(isActiveRemittance);
  const today = todayIstYmd();
  const portalEnd = maxYmd(requestDate, today);
  const portalStart = addDaysYmd(portalEnd, -(REMITTANCE_LOOKBACK_DAYS - 1));

  let mode: RemittanceMatchMode = 'none';
  let fromDate = requestDate;
  let toDate = requestDate;
  let limitedByRemittanceWindow = false;

  if (cashMatches(sameDayRemittance, sameDayExpected)) {
    mode = 'sameDay';
  } else {
    const later = active
      .filter((r) => r.creationDate > dayRange.endTime)
      .sort((a, b) => a.creationDate - b.creationDate);

    if (later.length > 0) {
      mode = 'forwardDeposit';
      const latestLater = ymdFromIstEpochMs(later[later.length - 1]!.creationDate);
      toDate = minYmd(latestLater, addDaysYmd(requestDate, AGEING_PENDING_LOOKBACK_DAYS));
    } else if (sameDayRemittance > sameDayExpected + REMITTANCE_CASH_TOLERANCE) {
      mode = 'backwardPileUp';
      const prior = active
        .filter((r) => r.creationDate < dayRange.startTime)
        .sort((a, b) => b.creationDate - a.creationDate);
      if (prior.length > 0) {
        fromDate = maxYmd(
          ymdFromIstEpochMs(prior[0]!.creationDate),
          addDaysYmd(requestDate, -AGEING_PENDING_LOOKBACK_DAYS),
        );
      } else {
        fromDate = addDaysYmd(requestDate, -AGEING_PENDING_LOOKBACK_DAYS);
        limitedByRemittanceWindow = true;
      }
    } else {
      // Under-remitted / empty same-day with no later remittance in portal
      mode = 'none';
      toDate = requestDate;
    }
  }

  // Clamp to remittance portal visibility
  if (fromDate < portalStart) {
    fromDate = portalStart;
    limitedByRemittanceWindow = true;
  }
  if (toDate > portalEnd) {
    toDate = portalEnd;
  }
  if (fromDate > toDate) {
    fromDate = requestDate;
    toDate = requestDate;
  }

  const windowStart = getBusinessDayRange(fromDate, startHourIst).startTime;
  const windowEnd = getBusinessDayRange(toDate, startHourIst).endTime;
  const windowRemittances = active.filter(
    (r) => r.creationDate >= windowStart && r.creationDate <= windowEnd,
  );

  return { fromDate, toDate, mode, limitedByRemittanceWindow, windowRemittances };
}

function buildLedgerDays(args: {
  fromDate: string;
  toDate: string;
  drivers: Driver[];
  packages: AgeingPackageDetail[];
  windowRemittances: RemittanceEntry[];
  clearedByTracking: Map<string, ClearedTracking>;
  workforceByTransporterId?: Map<string, WorkforceAssociate>;
}): RemittanceLedgerDay[] {
  const {
    fromDate,
    toDate,
    drivers,
    packages,
    windowRemittances,
    clearedByTracking,
    workforceByTransporterId,
  } = args;

  const expectedByDay = new Map<string, ReturnType<typeof buildExpectedCashFromAgeing>>();
  // Split packages by updateDate for per-day expected totals
  const packagesByDay = new Map<string, AgeingPackageDetail[]>();
  for (const pkg of packages) {
    const day =
      (pkg.lastUpdatedTime && /^(\d{4}-\d{2}-\d{2})/.exec(pkg.lastUpdatedTime.trim())?.[1]) ||
      fromDate;
    if (day < fromDate || day > toDate) continue;
    let list = packagesByDay.get(day);
    if (!list) {
      list = [];
      packagesByDay.set(day, list);
    }
    list.push(pkg);
  }

  for (const day of eachYmdInclusive(fromDate, toDate)) {
    expectedByDay.set(
      day,
      buildExpectedCashFromAgeing(
        drivers,
        packagesByDay.get(day) ?? [],
        workforceByTransporterId,
      ),
    );
  }

  const remittanceByDay = new Map<string, number>();
  for (const r of windowRemittances) {
    const day = ymdFromIstEpochMs(r.creationDate);
    remittanceByDay.set(day, round2((remittanceByDay.get(day) ?? 0) + (r.actualAmount?.value ?? 0)));
  }

  // Track which prior ageing amounts clear on each remittance day
  const clearedFromPriorByDay = new Map<string, number>();

  type OpenShipment = {
    day: string;
    driverName: string;
    tasId: string | null;
    employeeId: number | null;
    mappedFromWorkforce?: boolean;
    shipment: RemittanceLedgerShipment;
  };
  const openByDay = new Map<string, OpenShipment[]>();

  for (const day of eachYmdInclusive(fromDate, toDate)) {
    const expected = expectedByDay.get(day) ?? {
      totalReceived: 0,
      shipmentCount: 0,
      byDriver: [],
    };
    const opens: OpenShipment[] = [];

    for (const driver of expected.byDriver) {
      for (const sh of driver.shipments) {
        const trackingId = (sh.barcode ?? '').trim();
        if (!trackingId) continue;
        const amount = sh.receivedAmount.value;
        const cleared = clearedByTracking.get(trackingId);

        let status: RemittanceLedgerShipment['status'];
        let clearedOnDate: string | null = null;
        let keptDays: number | null = null;
        let remittanceId: string | null = null;
        let remittanceCode: string | null = null;

        if (cleared) {
          clearedOnDate = cleared.clearedOnDate;
          remittanceId = cleared.remittanceId;
          remittanceCode = cleared.remittanceCode;
          keptDays = Math.max(0, daysBetweenYmd(day, clearedOnDate));
          if (clearedOnDate === day) {
            status = 'clearedSameDay';
          } else if (clearedOnDate > day) {
            status = 'forwarded';
            clearedFromPriorByDay.set(
              clearedOnDate,
              round2((clearedFromPriorByDay.get(clearedOnDate) ?? 0) + amount),
            );
          } else {
            // Remitted before ageing update date — treat as same-day cleared noise
            status = 'clearedSameDay';
            clearedOnDate = day;
            keptDays = 0;
          }
        } else {
          status = 'pending';
        }

        // Only list forwarded + still-pending in driver detail (lean response)
        if (status === 'clearedSameDay') continue;

        opens.push({
          day,
          driverName: driver.driverName,
          tasId: driver.tasId,
          employeeId: driver.employeeId,
          mappedFromWorkforce: driver.mappedFromWorkforce,
          shipment: {
            trackingId,
            shipmentNo: sh.shipmentNo,
            pendingAmount: amount,
            keptOnDate: day,
            clearedOnDate,
            keptDays,
            status,
            remittanceId,
            remittanceCode,
          },
        });
      }
    }
    openByDay.set(day, opens);
  }

  const ledger: RemittanceLedgerDay[] = [];

  for (const day of eachYmdInclusive(fromDate, toDate)) {
    const expected = expectedByDay.get(day)!;
    const remittanceTotalCash = remittanceByDay.get(day) ?? 0;
    const opens = openByDay.get(day) ?? [];

    let forwardedAmount = 0;
    let stillPendingAmount = 0;
    for (const o of opens) {
      if (o.shipment.status === 'forwarded') forwardedAmount += o.shipment.pendingAmount;
      else stillPendingAmount += o.shipment.pendingAmount;
    }
    forwardedAmount = round2(forwardedAmount);
    stillPendingAmount = round2(stillPendingAmount);
    const clearedSameDayAmount = round2(
      Math.max(0, expected.totalReceived - forwardedAmount - stillPendingAmount),
    );

    const shortAmount = round2(expected.totalReceived - remittanceTotalCash);
    const clearedFromPriorAmount = clearedFromPriorByDay.get(day) ?? 0;
    const carryForwardOut = round2(forwardedAmount + stillPendingAmount);

    const driverMap = new Map<string, RemittanceLedgerDriver>();
    for (const o of opens) {
      const key = o.tasId ?? o.driverName;
      let d = driverMap.get(key);
      if (!d) {
        d = {
          driverName: o.driverName,
          tasId: o.tasId,
          employeeId: o.employeeId,
          mappedFromWorkforce: o.mappedFromWorkforce,
          amount: 0,
          shipmentCount: 0,
          shipments: [],
        };
        driverMap.set(key, d);
      }
      d.shipments.push(o.shipment);
      d.amount = round2(d.amount + o.shipment.pendingAmount);
      d.shipmentCount += 1;
    }
    const driversList = [...driverMap.values()].sort((a, b) => b.amount - a.amount);

    ledger.push({
      date: day,
      expectedCashTotal: expected.totalReceived,
      remittanceTotalCash,
      shortAmount,
      carryForwardIn: 0,
      carryForwardOut,
      clearedSameDayAmount,
      forwardedAmount,
      stillPendingAmount,
      clearedFromPriorAmount: round2(clearedFromPriorAmount),
      drivers: driversList,
    });
  }

  let openCarry = 0;
  for (const day of ledger) {
    day.carryForwardIn = round2(openCarry);
    openCarry = round2(
      Math.max(0, openCarry + day.forwardedAmount + day.stillPendingAmount - day.clearedFromPriorAmount),
    );
    day.carryForwardOut = round2(day.forwardedAmount + day.stillPendingAmount);
  }

  return ledger;
}

/**
 * Day-by-day remittance ↔ ageing ledger using exact trackingId clearance
 * from /v1/getRemittanceDetailsForExcel.
 */
export async function reconcileRemittancePending(args: {
  stationCode: string;
  requestDate: string;
  startHourIst: number;
  drivers: Driver[];
  allRemittances: RemittanceEntry[];
  sameDayExpectedCash: ExpectedCashSummary;
  sameDayRemittances: RemittanceEntry[];
  provider: StationDataProvider;
  auth: AmazonAuthContext;
  workforceByTransporterId?: Map<string, WorkforceAssociate>;
}): Promise<RemittanceLedgerResult> {
  const {
    stationCode,
    requestDate,
    startHourIst,
    drivers,
    allRemittances,
    sameDayExpectedCash,
    sameDayRemittances,
    provider,
    auth,
    workforceByTransporterId,
  } = args;

  const sameDayExpected = sameDayExpectedCash.totalReceived;
  const sameDayRemittance = sumRemittanceCash(sameDayRemittances);
  const sameDayShort = round2(sameDayExpected - sameDayRemittance);

  const { fromDate, toDate, mode, limitedByRemittanceWindow, windowRemittances } = resolveWindow({
    requestDate,
    startHourIst,
    sameDayExpected,
    sameDayRemittance,
    allRemittances,
  });

  // Same-day match: no need for details / multi-day ageing
  if (mode === 'sameDay' && cashMatches(sameDayRemittance, sameDayExpected)) {
    const day: RemittanceLedgerDay = {
      date: requestDate,
      expectedCashTotal: sameDayExpected,
      remittanceTotalCash: sameDayRemittance,
      shortAmount: sameDayShort,
      carryForwardIn: 0,
      carryForwardOut: 0,
      clearedSameDayAmount: sameDayExpected,
      forwardedAmount: 0,
      stillPendingAmount: 0,
      clearedFromPriorAmount: 0,
      drivers: [],
    };
    return {
      summary: {
        status: 'MATCHED',
        mode: 'sameDay',
        window: { from: requestDate, to: requestDate },
        sameDayExpectedCashTotal: sameDayExpected,
        sameDayRemittanceTotalCash: sameDayRemittance,
        sameDayShortAmount: sameDayShort,
        finalPendingTotal: 0,
        limitedByRemittanceWindow: false,
      },
      ledger: [day],
      analysisRemittances: sameDayRemittances,
    };
  }

  const packages =
    fromDate === toDate
      ? // reuse already-fetched same-day packages when possible via provider call
        await provider.getAgeingDrillDownData(stationCode, fromDate, auth)
      : await provider.getAgeingDrillDownData(stationCode, fromDate, auth, toDate);

  const clearedByTracking = await buildClearedTrackingMap(windowRemittances, provider, auth);

  const ledger = buildLedgerDays({
    fromDate,
    toDate,
    drivers,
    packages,
    windowRemittances,
    clearedByTracking,
    workforceByTransporterId,
  });

  const finalPendingTotal = round2(
    ledger.reduce((sum, d) => sum + d.stillPendingAmount, 0),
  );
  const requestDay = ledger.find((d) => d.date === requestDate);
  const windowExpected = round2(ledger.reduce((s, d) => s + d.expectedCashTotal, 0));
  const windowRemittance = round2(ledger.reduce((s, d) => s + d.remittanceTotalCash, 0));

  let status: RemittanceMatchStatus;
  if (finalPendingTotal <= REMITTANCE_CASH_TOLERANCE && cashMatches(windowExpected, windowRemittance)) {
    status = mode === 'sameDay' ? 'MATCHED' : 'MATCHED_WINDOW';
  } else if (finalPendingTotal <= REMITTANCE_CASH_TOLERANCE && (requestDay?.shortAmount ?? sameDayShort) <= REMITTANCE_CASH_TOLERANCE) {
    status = 'MATCHED_WINDOW';
  } else if (limitedByRemittanceWindow && finalPendingTotal > REMITTANCE_CASH_TOLERANCE) {
    status = 'UNRESOLVED';
  } else if (finalPendingTotal > REMITTANCE_CASH_TOLERANCE || Math.abs(sameDayShort) > REMITTANCE_CASH_TOLERANCE) {
    status = 'PENDING';
  } else {
    status = 'MATCHED_WINDOW';
  }

  return {
    summary: {
      status,
      mode,
      window: { from: fromDate, to: toDate },
      sameDayExpectedCashTotal: sameDayExpected,
      sameDayRemittanceTotalCash: sameDayRemittance,
      sameDayShortAmount: sameDayShort,
      finalPendingTotal,
      limitedByRemittanceWindow,
    },
    ledger,
    analysisRemittances: windowRemittances,
  };
}

export { sumRemittanceCash };
