import type { Driver } from '../types';

/** Store counterparties may have no TAS ID. Resolve only an unambiguous
 * station-roster match and preserve its real employee/store identifier. */
export function reconciliationIdentity(
  info: { driverName?: string; name?: string; tasId?: string | null; id?: string | null; store?: boolean },
  drivers: Driver[],
  store = false,
): string | null {
  const direct = String(info.tasId ?? info.id ?? '').trim();
  if (direct) return direct;
  const name = String(info.driverName ?? info.name ?? '').trim();
  if (!name) return null;
  const matches = drivers.filter(driver => driver.driverName?.trim() === name && Boolean(driver.store) === Boolean(info.store ?? store));
  const match = matches[0];
  if (matches.length !== 1 || !match || match.employeeId == null) return null;
  return String(match.employeeId).trim() || null;
}
