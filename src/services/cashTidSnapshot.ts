import { cachedClosedStationCodes } from '../stationClosures';
import type {
  Env,
  AgeingPackageDetail,
  AmazonAuthContext,
  CashTidSnapshotRow,
  Driver,
  DriverReconciliationEntry,
} from '../types';
import {
  ALLOWED_STATIONS,
  CASH_TID_BATCH_CHUNK_SIZE,
  CASH_TID_SNAPSHOT_RETENTION_DAYS,
  normalizeTransporterId,
} from '../config';
import type { NewCashTid } from '../store/CashTidSnapshotStore';
import { createCashTidSnapshotStore } from '../store/factory';
import { createStationDataProvider } from '../providers/factory';
import type { StationDataProvider } from '../providers/StationDataProvider';
import { ensureValidAmazonSession } from '../session/ensureSession';
import {
  addDaysYmd,
  ageingCalendarYmd,
  istTimestampFromEpochMs,
  parseAgeingUpdatedMs,
  todayIstYmd,
} from '../utils/dateRange';
import { classifyReconState, reconOnlyCashPackages } from '../utils/reconState';

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toNewCashTid(pkg: AgeingPackageDetail): NewCashTid {
  return {
    trackingId: pkg.trackingId,
    capturedState: pkg.state,
    expectedAmount: pkg.receivableAmount || pkg.orderAmount || 0,
    driverId: pkg.driverId,
  };
}

export type CashTidSnapshotResult = {
  stationCode: string;
  ok: boolean;
  captured?: number;
  error?: string;
};

/**
 * Nightly capture (23:00 IST): anchor every cash tracking ID in today's ageing feed —
 * Cash In Associate, Cash At Station and Delivered alike — to today. Insert-if-absent,
 * so a TID already anchored to an earlier day (e.g. yesterday's cash the associate only
 * handed over this morning) keeps its original date.
 */
export async function captureStationCashSnapshot(env: Env, stationCode: string): Promise<CashTidSnapshotResult> {
  const code = stationCode.trim().toUpperCase();
  const businessDate = todayIstYmd();

  const session = await ensureValidAmazonSession(env, {
    stationCode: code,
    triggeredBy: `cash-tid-snapshot-capture:${code}`,
    notifyOnFailure: false,
  });
  if (!session.ok) {
    return { stationCode: code, ok: false, error: session.error || `Amazon session failed (${session.code})` };
  }

  try {
    const provider = createStationDataProvider(env);
    const packages = await provider.getAgeingDrillDownData(
      code,
      businessDate,
      session.auth,
      undefined,
      undefined,
      Number(env.BUSINESS_DAY_START_HOUR_IST ?? '5'),
    );
    const tids = packages.filter((pkg) => pkg.trackingId && isCashMethod(pkg.actualPaymentMethod)).map(toNewCashTid);
    const captured = await createCashTidSnapshotStore(env).anchorTids(code, businessDate, tids);
    return { stationCode: code, ok: true, captured };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Cash-TID snapshot capture failed for ${code}`, err);
    return { stationCode: code, ok: false, error: message };
  }
}

export type CarryoverBackfillResult = {
  stationCode: string;
  ok: boolean;
  applied: boolean;
  date: string;
  anchorDate: string;
  count?: number;
  total?: number;
  byDriver?: Array<{ driverId: string | null; count: number; total: number }>;
  trackingIds?: string[];
  error?: string;
};

/**
 * One-time bootstrap for a day with no snapshot history for the day before (the table
 * did not exist yet). Stations reconcile the previous day's Cash In Associate in a
 * morning batch, which moves those packages to Cash At Station with today's
 * lastUpdatedTime, so they show up in today's expected cash. Rows that are Cash At
 * Station and were updated on `date` before `cutoffIst` (HH:MM) are anchored to
 * `anchorDate`, so today excludes them. Nothing is written unless `apply` is true;
 * without it this is a preview of exactly what would be moved.
 */
export async function backfillMorningCarryover(
  env: Env,
  params: { stationCode: string; date: string; anchorDate: string; cutoffIst: string; apply: boolean },
): Promise<CarryoverBackfillResult> {
  const code = params.stationCode.trim().toUpperCase();
  const base = { stationCode: code, applied: false, date: params.date, anchorDate: params.anchorDate };
  const [hh, mm] = params.cutoffIst.split(':').map(Number);
  const cutoffMinutes = (hh ?? 0) * 60 + (mm ?? 0);

  const session = await ensureValidAmazonSession(env, {
    stationCode: code,
    triggeredBy: `cash-tid-snapshot-backfill:${code}`,
    notifyOnFailure: false,
  });
  if (!session.ok) {
    return { ...base, ok: false, error: session.error || `Amazon session failed (${session.code})` };
  }

  try {
    const provider = createStationDataProvider(env);
    const packages = await provider.getAgeingDrillDownData(
      code,
      params.date,
      session.auth,
      undefined,
      ['Cash At Station'],
      Number(env.BUSINESS_DAY_START_HOUR_IST ?? '5'),
    );
    const carried = packages.filter((pkg) => {
      if (!pkg.trackingId || !isCashMethod(pkg.actualPaymentMethod)) return false;
      if (classifyReconState(pkg.state) !== 'completed') return false;
      if (ageingCalendarYmd(pkg.lastUpdatedTime) !== params.date) return false;
      const ms = parseAgeingUpdatedMs(pkg.lastUpdatedTime);
      if (ms == null) return false;
      const ist = new Date(ms + 330 * 60 * 1000);
      return ist.getUTCHours() * 60 + ist.getUTCMinutes() < cutoffMinutes;
    });

    const byDriverMap = new Map<string, { driverId: string | null; count: number; total: number }>();
    for (const pkg of carried) {
      const key = pkg.driverId ?? '';
      const entry = byDriverMap.get(key) ?? { driverId: pkg.driverId, count: 0, total: 0 };
      entry.count += 1;
      entry.total = Math.round((entry.total + (pkg.receivableAmount || 0) / 100) * 100) / 100;
      byDriverMap.set(key, entry);
    }
    const total = Math.round(carried.reduce((sum, pkg) => sum + (pkg.receivableAmount || 0), 0)) / 100;

    let applied = false;
    if (params.apply && carried.length > 0) {
      await createCashTidSnapshotStore(env).anchorTids(code, params.anchorDate, carried.map(toNewCashTid));
      applied = true;
    }
    return {
      ...base,
      ok: true,
      applied,
      count: carried.length,
      total,
      byDriver: [...byDriverMap.values()].sort((a, b) => b.total - a.total),
      trackingIds: carried.map((pkg) => pkg.trackingId),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Cash-TID carryover backfill failed for ${code}`, err);
    return { ...base, ok: false, error: message };
  }
}

/**
 * Anchor what a reconciliation view for `businessDate` just saw. Only rows whose
 * lastUpdatedTime is the moment the cash was collected (Cash In Associate / Delivered)
 * and falls on `businessDate` are trusted here. Cash At Station rows are skipped: their
 * lastUpdatedTime is the handover, which can be a day after delivery, so anchoring them
 * from a view could lock yesterday's cash onto today.
 */
export async function anchorViewedCashTids(
  env: Env,
  stationCode: string,
  businessDate: string,
  packages: AgeingPackageDetail[],
): Promise<void> {
  const tids = packages
    .filter((pkg) => pkg.trackingId && isCashMethod(pkg.actualPaymentMethod))
    .filter((pkg) => classifyReconState(pkg.state) !== 'completed')
    .filter((pkg) => ageingCalendarYmd(pkg.lastUpdatedTime) === businessDate)
    .map(toNewCashTid);
  if (tids.length === 0) return;
  try {
    await createCashTidSnapshotStore(env).anchorTids(stationCode, businessDate, tids);
  } catch (err) {
    console.error(`Cash-TID snapshot anchor-on-view failed for ${stationCode}/${businessDate}`, err);
  }
}

/** Stop starting new stations past this wall-clock budget for one cron tick. Stations
 * skipped tonight are still covered by anchor-on-view, and the start station rotates
 * daily so the same tail of the list is not skipped every night. */
const SNAPSHOT_RUN_WALL_BUDGET_MS = 20_000;

function rotatedStationList(): string[] {
  const closed = cachedClosedStationCodes();
  const stations = [...ALLOWED_STATIONS].filter((code) => !closed.has(code)).sort();
  const dayIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const offset = dayIndex % stations.length;
  return [...stations.slice(offset), ...stations.slice(0, offset)];
}

/** Run capture for every allowed station within one wall-time budget, then purge. */
export async function runCashTidSnapshotForAllStations(env: Env): Promise<CashTidSnapshotResult[]> {
  const results: CashTidSnapshotResult[] = [];
  const startedAt = Date.now();
  const stations = rotatedStationList();

  for (const code of stations) {
    if (Date.now() - startedAt > SNAPSHOT_RUN_WALL_BUDGET_MS) {
      console.warn(
        `Cash-TID snapshot: wall-time budget hit after ${results.length}/${stations.length} stations; `
          + `skipped: ${stations.slice(results.length).join(',')}`,
      );
      break;
    }
    results.push(await captureStationCashSnapshot(env, code));
  }
  const purged = await createCashTidSnapshotStore(env).purgeOlderThan(CASH_TID_SNAPSHOT_RETENTION_DAYS);
  console.log(`Cash-TID snapshot: purged ${purged} row(s) older than ${CASH_TID_SNAPSHOT_RETENTION_DAYS} days`);
  return results;
}

/**
 * Fill in tracking IDs the date-filtered ageing feed no longer shows for `businessDate`
 * (because a late handover moved their lastUpdatedTime to a later day) without touching
 * anything the feed already has right for this date.
 */
export function mergeSnapshotIntoAgeing(
  ageingPackages: AgeingPackageDetail[],
  snapshotPackages: AgeingPackageDetail[],
): AgeingPackageDetail[] {
  if (snapshotPackages.length === 0) return ageingPackages;
  const seen = new Set(ageingPackages.map((p) => p.trackingId));
  const extra = snapshotPackages.filter((p) => p.trackingId && !seen.has(p.trackingId));
  return extra.length === 0 ? ageingPackages : [...ageingPackages, ...extra];
}

/**
 * Of `trackingIds`, the ones anchored to some OTHER business date — must be excluded
 * from `businessDate`, or yesterday's cash handed over this morning (lastUpdatedTime now
 * today) gets counted on both days.
 */
export async function loadTrackingIdsClaimedByOtherDates(
  env: Env,
  stationCode: string,
  businessDate: string,
  trackingIds: string[],
): Promise<Set<string>> {
  try {
    const store = createCashTidSnapshotStore(env);
    const ids = await store.listTrackingIdsAnchoredElsewhere(
      stationCode.trim().toUpperCase(),
      businessDate,
      trackingIds,
    );
    return new Set(ids);
  } catch (err) {
    console.error(`Cash-TID snapshot claimed-elsewhere lookup failed for ${stationCode}/${businessDate}`, err);
    return new Set();
  }
}

/** Re-check snapshot rows live (state/driver) and reshape them as ageing rows. Amount and
 * payment method come from the captured ageing row, in the units the pipeline expects. */
async function reshapeSnapshotRows(
  rows: CashTidSnapshotRow[],
  code: string,
  provider: StationDataProvider,
  auth: AmazonAuthContext,
): Promise<AgeingPackageDetail[]> {
  if (rows.length === 0) return [];
  const summaries = (
    await Promise.all(
      chunk(rows.map((row) => row.trackingId), CASH_TID_BATCH_CHUNK_SIZE).map((ids) =>
        provider.getPackageSummaryBatch(code, ids, auth).catch((err) => {
          console.error(`Cash-TID snapshot live re-check failed for ${code}`, err);
          return [];
        }),
      ),
    )
  ).flat();
  const byTrackingId = new Map(summaries.map((s) => [s.trackingId, s]));

  return rows.map((row) => {
    const summary = byTrackingId.get(row.trackingId);
    return {
      trackingId: row.trackingId,
      driverId: summary?.driverId ?? row.driverId,
      paymentMethod: 'CASH',
      actualPaymentMethod: 'CASH',
      receivableAmount: row.expectedAmount,
      orderAmount: row.expectedAmount,
      state: summary?.currentPackageState ?? row.capturedState,
      reason: null,
      packageType: null,
      lastUpdatedTime:
        summary?.lastUpdatedTime != null ? istTimestampFromEpochMs(summary.lastUpdatedTime) : row.lastCheckedAt,
      orderingOrderId: null,
      stationCode: code,
      dspName: null,
      accessPointId: null,
    };
  });
}

/**
 * Snapshot rows anchored to `businessDate`, re-checked live and reshaped as
 * AgeingPackageDetail so they merge straight into the normal ageing-cash computation.
 */
export async function loadSnapshotPackagesForDate(
  env: Env,
  stationCode: string,
  businessDate: string,
  provider: StationDataProvider,
  auth: AmazonAuthContext,
): Promise<AgeingPackageDetail[]> {
  const code = stationCode.trim().toUpperCase();
  const rows = await createCashTidSnapshotStore(env).listTidsForDate(code, businessDate);
  return reshapeSnapshotRows(rows, code, provider, auth);
}

/**
 * Ops Pulse tech-issue hold for one associate on the requested business date:
 * - `held`: the issue is open on this date. The associate's cash is still with them in
 *   Amazon, so it is taken out of this day's expected cash (reported as `held`) and the
 *   station can close the day without it.
 * - `released`: the issue was resolved on this date. All cash held since `since` is
 *   carried into this day's expected cash, even though it is anchored to earlier days.
 */
export type TechHold = {
  /** tasId or employeeId, as Ops Pulse stores it (provider_employee_id). */
  driverId: string;
  /** Business date the issue was raised (first held day). */
  since: string;
  status: 'held' | 'released';
};

export function parseTechHolds(value: unknown): TechHold[] {
  if (!Array.isArray(value)) return [];
  const out: TechHold[] = [];
  for (const item of value) {
    const row = item as Partial<TechHold> | null;
    const driverId = String(row?.driverId ?? '').trim();
    const since = String(row?.since ?? '').trim();
    const status = row?.status === 'released' ? 'released' : row?.status === 'held' ? 'held' : null;
    if (!driverId || !status || !/^\d{4}-\d{2}-\d{2}$/.test(since)) continue;
    out.push({ driverId, since, status });
  }
  return out;
}

/** Stable cache-key suffix so a hold change never serves a response cached without it. */
export function techHoldsCacheKey(holds: TechHold[]): string {
  if (holds.length === 0) return '';
  return `:holds=${holds
    .map((h) => `${normalizeTransporterId(h.driverId)}@${h.since}/${h.status}`)
    .sort()
    .join(',')}`;
}

/** Map Ops Pulse associate ids (employeeId or tasId) to ageing driverIds (tasId). */
function resolveHoldTasIds(holds: TechHold[], drivers: Driver[]): Array<TechHold & { tasId: string }> {
  return holds.map((hold) => {
    const id = normalizeTransporterId(hold.driverId);
    const driver = drivers.find(
      (d) => normalizeTransporterId(String(d.employeeId ?? '')) === id || normalizeTransporterId(d.tasId) === id,
    );
    return { ...hold, tasId: driver?.tasId ? driver.tasId.trim() : hold.driverId.trim() };
  });
}

export type DateScopedCash = {
  /** Packages counted in this day's expected cash. */
  packages: AgeingPackageDetail[];
  /** Tech-issue associates' packages held out of this day (still with the associate). */
  held: AgeingPackageDetail[];
};

/**
 * The cash packages that belong to `businessDate`, shared by every view that shows a
 * day's expected cash (driver reconciliation, remittance) so they always agree:
 *  - the ageing feed for the date,
 *  - plus recon-pending cash TIDs the feed never returns (alphanumeric AP IDs),
 *  - minus TIDs anchored to another date (yesterday's cash handed over this morning),
 *  - plus TIDs anchored to this date that a late handover moved out of its feed,
 *  - with tech-issue holds applied (held out while open, carried in on the resolve day).
 * Also anchors this date's collected-cash TIDs (fire-and-forget via `waitUntil`).
 */
export async function loadDateScopedCashPackages(args: {
  env: Env;
  provider: StationDataProvider;
  auth: AmazonAuthContext;
  stationCode: string;
  businessDate: string;
  range: { startTime: number; endTime: number };
  reconciliation: DriverReconciliationEntry[];
  ageingPackagesRaw: AgeingPackageDetail[];
  drivers: Driver[];
  techHolds?: TechHold[];
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<DateScopedCash> {
  const { env, provider, auth, stationCode, businessDate, range, reconciliation, ageingPackagesRaw } = args;
  const code = stationCode.trim().toUpperCase();
  const holds = resolveHoldTasIds(args.techHolds ?? [], args.drivers);
  const heldTas = new Set(holds.filter((h) => h.status === 'held').map((h) => normalizeTransporterId(h.tasId)));
  const released = holds.filter((h) => h.status === 'released' && h.since < businessDate);
  const releasedTas = new Set(released.map((h) => normalizeTransporterId(h.tasId)));

  // Never throws: a snapshot hiccup degrades to "ageing feed only" instead of failing the request.
  const [snapshotPackages, carriedPackages] = await Promise.all([
    loadSnapshotPackagesForDate(env, code, businessDate, provider, auth).catch((err) => {
      console.error(`Cash-TID snapshot merge lookup failed for ${code}/${businessDate}`, err);
      return [] as AgeingPackageDetail[];
    }),
    // Resolve day: pull every TID held since the issue opened into today.
    Promise.all(
      released.map(async (hold) => {
        const rows = await createCashTidSnapshotStore(env).listTidsForDriverBetween(
          code,
          hold.tasId,
          hold.since,
          addDaysYmd(businessDate, -1),
        );
        return reshapeSnapshotRows(rows, code, provider, auth);
      }),
    )
      .then((lists) => lists.flat())
      .catch((err) => {
        console.error(`Tech-issue carried cash lookup failed for ${code}/${businessDate}`, err);
        return [] as AgeingPackageDetail[];
      }),
  ]);

  const knownIds = new Set([...ageingPackagesRaw, ...snapshotPackages].map((pkg) => pkg.trackingId));
  const candidates = [...ageingPackagesRaw, ...reconOnlyCashPackages(reconciliation, range, knownIds)];

  const claimedElsewhere = await loadTrackingIdsClaimedByOtherDates(
    env,
    code,
    businessDate,
    candidates.map((pkg) => pkg.trackingId),
  );
  // A released associate's cash was anchored to the held days on purpose; on the resolve
  // day it belongs here, so the anchor exclusion is skipped for them.
  const ownedByThisDate = candidates.filter(
    (pkg) => !claimedElsewhere.has(pkg.trackingId) || releasedTas.has(normalizeTransporterId(pkg.driverId)),
  );

  const anchoring = anchorViewedCashTids(env, code, businessDate, ownedByThisDate);
  if (args.waitUntil) args.waitUntil(anchoring);
  else await anchoring;

  const merged = mergeSnapshotIntoAgeing(ownedByThisDate, [...snapshotPackages, ...carriedPackages]);
  if (heldTas.size === 0) return { packages: merged, held: [] };
  const isHeld = (pkg: AgeingPackageDetail) => heldTas.has(normalizeTransporterId(pkg.driverId));
  return { packages: merged.filter((pkg) => !isHeld(pkg)), held: merged.filter(isHeld) };
}
