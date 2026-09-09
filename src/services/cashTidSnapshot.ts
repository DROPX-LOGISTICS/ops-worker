import type { Env, AgeingPackageDetail } from '../types';
import {
  ALLOWED_STATIONS,
  CASH_TID_BATCH_CHUNK_SIZE,
  CASH_TID_SNAPSHOT_RETENTION_DAYS,
} from '../config';
import type { NewCashTid } from '../store/CashTidSnapshotStore';
import { createCashTidSnapshotStore } from '../store/factory';
import { createStationDataProvider } from '../providers/factory';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { todayIstYmd, ymdFromIstEpochMs } from '../utils/dateRange';

const CASH_AT_STATION = 'CASH_AT_STATION';

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

function stationList(): string[] {
  return [...ALLOWED_STATIONS].sort();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type CashTidSnapshotResult = {
  stationCode: string;
  ok: boolean;
  captured?: number;
  resolved?: number;
  error?: string;
};

/**
 * Capture: snapshot every CASH_AT_STATION / cash-expected package currently sitting at
 * this station. Run nightly at the station's cutoff (23:00 IST) so a TID still open at
 * that instant is anchored to *today's* business date — even if the store only hands the
 * cash to the station tomorrow (which would otherwise move it to tomorrow's ageing bucket).
 */
export async function captureStationCashSnapshot(env: Env, stationCode: string): Promise<CashTidSnapshotResult> {
  const code = stationCode.trim().toUpperCase();
  const store = createCashTidSnapshotStore(env);
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
      businessDate,
      ['Cash At Station'],
    );

    const openCashTids: NewCashTid[] = packages
      .filter((pkg) => pkg.trackingId && isCashMethod(pkg.actualPaymentMethod ?? pkg.paymentMethod))
      .filter((pkg) => (pkg.state ?? '').trim().toUpperCase().replace(/\s+/g, '_') === CASH_AT_STATION)
      .map((pkg) => ({
        trackingId: pkg.trackingId,
        capturedState: pkg.state,
        expectedAmount: pkg.receivableAmount || pkg.orderAmount || 0,
        driverId: pkg.driverId,
      }));

    await store.upsertOpenTids(code, businessDate, openCashTids);
    return { stationCode: code, ok: true, captured: openCashTids.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Cash-TID snapshot capture failed for ${code}`, err);
    return { stationCode: code, ok: false, error: message };
  }
}

/**
 * Resolve: re-check every open snapshot row for this station by tracking ID
 * (batchGetPackageSummary), independent of any date filter. A row whose package has
 * moved out of CASH_AT_STATION has had its cash accounted for (deposited, returned,
 * written off, whatever the actual outcome) and is deleted — "completed all the steps".
 */
export async function resolveStationCashSnapshot(env: Env, stationCode: string): Promise<CashTidSnapshotResult> {
  const code = stationCode.trim().toUpperCase();
  const store = createCashTidSnapshotStore(env);

  const open = await store.listOpenTids(code);
  if (open.length === 0) return { stationCode: code, ok: true, resolved: 0 };

  const session = await ensureValidAmazonSession(env, {
    stationCode: code,
    triggeredBy: `cash-tid-snapshot-resolve:${code}`,
    notifyOnFailure: false,
  });
  if (!session.ok) {
    return { stationCode: code, ok: false, error: session.error || `Amazon session failed (${session.code})` };
  }

  try {
    const provider = createStationDataProvider(env);
    const batches = chunk(open.map((row) => row.trackingId), CASH_TID_BATCH_CHUNK_SIZE);
    const summaries = (
      await Promise.all(batches.map((ids) => provider.getPackageSummaryBatch(code, ids, session.auth)))
    ).flat();
    const byTrackingId = new Map(summaries.map((s) => [s.trackingId, s]));

    const resolvedIds: string[] = [];
    for (const row of open) {
      const summary = byTrackingId.get(row.trackingId);
      // Not found at all in the live lookup (e.g. archived past Amazon's retention) —
      // treat as resolved rather than tracking it forever.
      const state = (summary?.currentPackageState ?? '').trim().toUpperCase().replace(/\s+/g, '_');
      if (!summary || state !== CASH_AT_STATION) {
        resolvedIds.push(row.trackingId);
      }
    }

    const resolved = await store.deleteResolved(code, resolvedIds);
    return { stationCode: code, ok: true, resolved };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Cash-TID snapshot resolve failed for ${code}`, err);
    return { stationCode: code, ok: false, error: message };
  }
}

/** Stop starting new stations past this wall-clock budget for one cron tick — ~38
 * stations x 2 sequential Amazon round trips can otherwise run long enough to risk
 * Cloudflare's execution limits (the exact problem CIA's chunked run/claim machinery
 * exists to avoid). A snapshot is a nightly rolling job, not a must-finish-tonight
 * ledger, so stations skipped this tick are simply picked up (resolve first, so
 * nothing is double-counted) on tomorrow's run. */
const SNAPSHOT_RUN_WALL_BUDGET_MS = 20_000;

/** Run capture, then resolve, for every allowed station within one wall-time budget. */
export async function runCashTidSnapshotForAllStations(env: Env): Promise<CashTidSnapshotResult[]> {
  const results: CashTidSnapshotResult[] = [];
  const startedAt = Date.now();
  const stations = stationList();

  for (const code of stations) {
    if (Date.now() - startedAt > SNAPSHOT_RUN_WALL_BUDGET_MS) {
      console.warn(
        `Cash-TID snapshot: wall-time budget hit after ${results.length}/${stations.length} stations; `
          + 'remaining stations deferred to the next run',
      );
      break;
    }
    const resolveResult = await resolveStationCashSnapshot(env, code);
    const captureResult = await captureStationCashSnapshot(env, code);
    results.push({
      stationCode: code,
      ok: resolveResult.ok && captureResult.ok,
      captured: captureResult.captured,
      resolved: resolveResult.resolved,
      error: [resolveResult.error, captureResult.error].filter(Boolean).join('; ') || undefined,
    });
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
 * Snapshot rows for `businessDate`, re-checked live and reshaped as AgeingPackageDetail so
 * they can merge straight into the normal ageing-cash computation — the fix for "the store
 * only paid the next day": that TID is still counted against businessDate, not whatever day
 * its lastUpdatedTime now shows.
 */
export async function loadSnapshotPackagesForDate(
  env: Env,
  stationCode: string,
  businessDate: string,
): Promise<AgeingPackageDetail[]> {
  const code = stationCode.trim().toUpperCase();
  const store = createCashTidSnapshotStore(env);
  const rows = await store.listOpenTidsForDate(code, businessDate);
  if (rows.length === 0) return [];

  const session = await ensureValidAmazonSession(env, {
    stationCode: code,
    triggeredBy: `cash-tid-snapshot-merge:${code}`,
    notifyOnFailure: false,
  });
  if (!session.ok) {
    // Fall back to the last-captured snapshot values rather than dropping these TIDs —
    // stale-but-present beats silently missing from the day's expected cash.
    return rows.map((row) => ({
      trackingId: row.trackingId,
      driverId: row.driverId,
      paymentMethod: 'CASH',
      actualPaymentMethod: 'CASH',
      receivableAmount: row.expectedAmount,
      orderAmount: row.expectedAmount,
      state: row.capturedState,
      reason: null,
      packageType: null,
      lastUpdatedTime: row.lastCheckedAt,
      orderingOrderId: null,
      stationCode: code,
      dspName: null,
      accessPointId: null,
    }));
  }

  const provider = createStationDataProvider(env);
  const batches = chunk(rows.map((row) => row.trackingId), CASH_TID_BATCH_CHUNK_SIZE);
  const summaries = (
    await Promise.all(batches.map((ids) => provider.getPackageSummaryBatch(code, ids, session.auth)))
  ).flat();
  const byTrackingId = new Map(summaries.map((s) => [s.trackingId, s]));

  return rows.map((row) => {
    const summary = byTrackingId.get(row.trackingId);
    if (!summary) {
      return {
        trackingId: row.trackingId,
        driverId: row.driverId,
        paymentMethod: 'CASH',
        actualPaymentMethod: 'CASH',
        receivableAmount: row.expectedAmount,
        orderAmount: row.expectedAmount,
        state: row.capturedState,
        reason: null,
        packageType: null,
        lastUpdatedTime: row.lastCheckedAt,
        orderingOrderId: null,
        stationCode: code,
        dspName: null,
        accessPointId: null,
      };
    }
    return {
      trackingId: summary.trackingId,
      driverId: summary.driverId ?? row.driverId,
      paymentMethod: summary.paymentMethod ?? 'CASH',
      actualPaymentMethod: summary.expectedPaymentMethod ?? 'CASH',
      receivableAmount: summary.receivableAmount ?? row.expectedAmount,
      orderAmount: summary.orderAmount ?? row.expectedAmount,
      state: summary.currentPackageState ?? row.capturedState,
      reason: null,
      packageType: null,
      lastUpdatedTime: summary.lastUpdatedTime == null ? row.lastCheckedAt : ymdFromIstEpochMs(summary.lastUpdatedTime),
      orderingOrderId: null,
      stationCode: code,
      dspName: null,
      accessPointId: null,
    };
  });
}
