import type { Driver, ExpectedCashByDriver, ExpectedCashSummary, ShipmentSettlementDetail } from '../types';
import { round2 } from './number';

function isCashMethod(method: string): boolean {
  return method.trim().toUpperCase() === 'CASH';
}
/**
 * Build station-level expected cash from per-driver shipment lists:
 * sum receivedAmount where paymentMethod is CASH.
 */
export function buildExpectedCash(
  drivers: Driver[],
  shipmentsByEmployeeId: Map<number, ShipmentSettlementDetail[]>,
): ExpectedCashSummary {
  const byDriver: ExpectedCashByDriver[] = [];
  const cashShipments: ShipmentSettlementDetail[] = [];
  let totalReceived = 0;

  for (const driver of drivers) {
    const all = shipmentsByEmployeeId.get(driver.employeeId) ?? [];
    const cash = all.filter((s) => isCashMethod(s.paymentMethod));
    if (cash.length === 0) continue;

    let driverTotal = 0;
    for (const s of cash) {
      driverTotal += s.receivedAmount?.value ?? 0;
      cashShipments.push(s);
    }
    driverTotal = round2(driverTotal);
    totalReceived += driverTotal;

    byDriver.push({
      employeeId: driver.employeeId,
      driverName: driver.driverName,
      tasId: driver.tasId,
      totalReceived: driverTotal,
      shipmentCount: cash.length,
      shipments: cash,
    });
  }

  return {
    totalReceived: round2(totalReceived),
    shipmentCount: cashShipments.length,
    byDriver,
    cashShipments,
  };
}
