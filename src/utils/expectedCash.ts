import type {
  Driver,
  ExpectedCashByDriver,
  ExpectedCashShipment,
  ExpectedCashSummary,
  AgeingPackageDetail,
} from '../types';
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
  shipments: ExpectedCashShipment[];
};

/**
 * Ageing CASH packages → expectedCash for the frontend.
 * Filters on actualPaymentMethod === CASH.
 * Matches driverId → drivers[].tasId when possible; unmatched driverIds
 * (e.g. A2S80CSWXBRVK9 not in getDrivers) are still returned with
 * mappedToActiveDriver: false so the UI can collect that cash.
 */
export function buildExpectedCashFromAgeing(
  drivers: Driver[],
  packages: AgeingPackageDetail[],
): ExpectedCashSummary {
  const cashPackages = packages.filter((p) => isCashMethod(p.actualPaymentMethod));
  const byTasId = new Map<string, Driver>();
  for (const d of drivers) {
    if (d.tasId) byTasId.set(d.tasId, d);
  }

  const buckets = new Map<string, Bucket>();

  for (const pkg of cashPackages) {
    const driverId = (pkg.driverId ?? '').trim();
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
          shipments: [],
        };
      } else if (driverId) {
        bucket = {
          employeeId: null,
          driverName: `Unmapped driver (${driverId})`,
          tasId: driverId,
          mappedToActiveDriver: false,
          shipments: [],
        };
      } else {
        bucket = {
          employeeId: null,
          driverName: 'Unassigned driver',
          tasId: null,
          mappedToActiveDriver: false,
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
