import type {
  Driver,
  ExpectedCashByDriver,
  ExpectedCashShipment,
  ExpectedCashSummary,
  AgeingPackageDetail,
  WorkforceAssociate,
} from '../types';
import { normalizeTransporterId } from '../config';
import { round2 } from './number';

function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').trim().toUpperCase() === 'CASH';
}

/** Ageing money fields are often in paise (e.g. 284723.0 → 2847.23). */
function toRupees(amount: number): number {
  return round2(amount / 100);
}

function dateOnly(lastUpdatedTime: string | null): string | null {
  if (!lastUpdatedTime) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(lastUpdatedTime.trim());
  if (m) return m[1]!;
  const part = lastUpdatedTime.trim().split(/\s+/)[0];
  return part || null;
}

function toShipment(pkg: AgeingPackageDetail, employeeId: number | null): ExpectedCashShipment {
  return {
    barcode: pkg.trackingId,
    shipmentNo: pkg.orderingOrderId,
    employeeId,
    paymentMethod: (pkg.actualPaymentMethod ?? pkg.paymentMethod).toUpperCase(),
    shipmentStatus: pkg.state,
    shipmentType: pkg.packageType,
    updateDate: dateOnly(pkg.lastUpdatedTime),
    receivableAmount: { value: toRupees(pkg.orderAmount ?? 0) },
    receivedAmount: { value: toRupees(pkg.receivableAmount) },
  };
}

type Bucket = {
  employeeId: number | null;
  driverName: string;
  tasId: string | null;
  mappedToActiveDriver: boolean;
  mappedFromWorkforce: boolean;
  shipments: ExpectedCashShipment[];
};

function lookupWorkforce(
  map: Map<string, WorkforceAssociate> | undefined,
  transporterId: string,
): WorkforceAssociate | undefined {
  if (!map) return undefined;
  const key = normalizeTransporterId(transporterId);
  return key ? map.get(key) : undefined;
}

/**
 * Ageing CASH packages → expectedCash for the frontend.
 * Filters on actualPaymentMethod === CASH.
 * Matches driverId → drivers[].tasId when possible; unmatched driverIds
 * fall back to workforce roster (transporter_id) when provided.
 */
export function buildExpectedCashFromAgeing(
  drivers: Driver[],
  packages: AgeingPackageDetail[],
  workforceByTransporterId?: Map<string, WorkforceAssociate>,
): ExpectedCashSummary {
  const cashPackages = packages.filter((p) => isCashMethod(p.actualPaymentMethod));
  const byTasId = new Map<string, Driver>();
  for (const d of drivers) {
    const tas = normalizeTransporterId(d.tasId);
    if (tas) byTasId.set(tas, d);
  }

  const buckets = new Map<string, Bucket>();

  for (const pkg of cashPackages) {
    const driverId = normalizeTransporterId(pkg.driverId);
    const bucketKey = driverId || '__unassigned__';
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      const driver = driverId ? byTasId.get(driverId) : undefined;
      if (driver) {
        bucket = {
          employeeId: driver.employeeId,
          driverName: driver.driverName,
          tasId: driver.tasId,
          mappedToActiveDriver: true,
          mappedFromWorkforce: false,
          shipments: [],
        };
      } else if (driverId) {
        const wf = lookupWorkforce(workforceByTransporterId, driverId);
        bucket = {
          employeeId: null,
          driverName: wf?.fullName ?? `Unmapped driver (${driverId})`,
          tasId: driverId,
          mappedToActiveDriver: false,
          mappedFromWorkforce: Boolean(wf),
          shipments: [],
        };
      } else {
        bucket = {
          employeeId: null,
          driverName: 'Unassigned driver',
          tasId: null,
          mappedToActiveDriver: false,
          mappedFromWorkforce: false,
          shipments: [],
        };
      }
      buckets.set(bucketKey, bucket);
    }
    bucket.shipments.push(toShipment(pkg, bucket.employeeId));
  }

  const byDriver: ExpectedCashByDriver[] = [];
  let totalReceived = 0;
  let shipmentCount = 0;

  for (const bucket of buckets.values()) {
    let driverTotal = 0;
    for (const s of bucket.shipments) driverTotal += s.receivedAmount.value;
    driverTotal = round2(driverTotal);
    totalReceived += driverTotal;
    shipmentCount += bucket.shipments.length;
    byDriver.push({
      employeeId: bucket.employeeId,
      driverName: bucket.driverName,
      tasId: bucket.tasId,
      mappedToActiveDriver: bucket.mappedToActiveDriver,
      mappedFromWorkforce: bucket.mappedFromWorkforce || undefined,
      totalReceived: driverTotal,
      shipmentCount: bucket.shipments.length,
      shipments: bucket.shipments,
    });
  }

  byDriver.sort((a, b) => b.totalReceived - a.totalReceived);

  return {
    totalReceived: round2(totalReceived),
    shipmentCount,
    byDriver,
  };
}
