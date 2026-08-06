import type {
  Driver,
  DriverReconciliationEntry,
  LiabilitySummary,
  RemittanceEntry,
  RemittanceDetails,
  AgeingPackageDetail,
  AmazonAuthContext,
} from '../types';
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

  /**
   * Ageing dashboard drill-down (`/os/getDrillDownData`).
   * Dates are YYYY-MM-DD; uses UTC calendar-day lastUpdatedRange (unix seconds).
   * When `toDate` is omitted, fetches a single calendar day.
   */
  getAgeingDrillDownData(
    stationCode: string,
    fromDate: string,
    auth: AmazonAuthContext,
    toDate?: string,
  ): Promise<AgeingPackageDetail[]>;

  getStationLiabilitySummary(stationCode: string, range: DateRange, auth: AmazonAuthContext): Promise<LiabilitySummary>;

  /**
   * Bank-deposits remittance list. `range` is the business-day filter hint;
   * the provider fetches a portal lookback ending at max(range end, today).
   */
  getRemittances(stationCode: string, range: DateRange, auth: AmazonAuthContext): Promise<RemittanceEntry[]>;

  /** Shipment-level remittance details for pending trackingId diff. */
  getRemittanceDetailsForExcel(remittanceId: string, auth: AmazonAuthContext): Promise<RemittanceDetails>;
}
