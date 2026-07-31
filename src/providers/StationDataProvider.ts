import type { Driver, DriverReconciliationEntry, LiabilitySummary, RemittanceEntry, AmazonAuthContext } from '../types';
import type { DateRange } from '../utils/dateRange';

/**
 * Everything the validation pipeline needs from "the station system", kept
 * behind an interface so the upstream can be swapped (a different Amazon
 * API generation, an internal service, a mock for tests, etc.) without
 * touching validators or the pipeline itself.
 *
 * `auth` is threaded through per-call rather than baked into the provider
 * instance because it is a per-request, per-user session — see
 * AmazonAuthContext for why.
 */
export interface StationDataProvider {
  getActiveDrivers(stationCode: string, auth: AmazonAuthContext): Promise<Driver[]>;

  getDriverReconciliation(
    stationCode: string,
    range: DateRange,
    drivers: Driver[],
    auth: AmazonAuthContext,
  ): Promise<DriverReconciliationEntry[]>;

  getStationLiabilitySummary(stationCode: string, range: DateRange, auth: AmazonAuthContext): Promise<LiabilitySummary>;

  getRemittances(stationCode: string, range: DateRange, auth: AmazonAuthContext): Promise<RemittanceEntry[]>;
}
