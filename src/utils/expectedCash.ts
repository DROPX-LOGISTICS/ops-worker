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

function toShipment(pkg: AgeingPackageDetail, employeeId: number): ExpectedCashShipment {
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

/**
 * Ageing CASH packages → expectedCash for the frontend.
 * Filters on actualPaymentMethod === CASH; maps driverId → drivers[].tasId.
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

  const buckets = new Map<string, { driver: Driver; shipments: ExpectedCashShipment[] }>();

  for (const pkg of cashPackages) {
    const driver = pkg.driverId ? byTasId.get(pkg.driverId) : undefined;
    if (!driver || !pkg.driverId) continue;

    let bucket = buckets.get(pkg.driverId);
    if (!bucket) {
      bucket = { driver, shipments: [] };
      buckets.set(pkg.driverId, bucket);
    }
    bucket.shipments.push(toShipment(pkg, driver.employeeId));
  }

  const byDriver: ExpectedCashByDriver[] = [];
  let totalReceived = 0;
  let shipmentCount = 0;

  for (const { driver, shipments } of buckets.values()) {
    let driverTotal = 0;
    for (const s of shipments) driverTotal += s.receivedAmount.value;
    driverTotal = round2(driverTotal);
    totalReceived += driverTotal;
    shipmentCount += shipments.length;
    byDriver.push({
      employeeId: driver.employeeId,
      driverName: driver.driverName,
      tasId: driver.tasId,
      totalReceived: driverTotal,
      shipmentCount: shipments.length,
      shipments,
    });
  }

  byDriver.sort((a, b) => b.totalReceived - a.totalReceived);

  return {
    totalReceived: round2(totalReceived),
    shipmentCount,
    byDriver,
  };
}
