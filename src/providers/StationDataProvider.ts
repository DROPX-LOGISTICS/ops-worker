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
 * Ageing packageStatusMap selector: plain bucket name (values = []) or a
 * bucket with sub-values, e.g. { status: 'Received', values: ['DS -> Customer'] }.
 */
export type AgeingStatusSelector = string | { status: string; values: string[] };

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
   * Dates are YYYY-MM-DD IST calendar days of lastUpdatedTime (Excel pivot style).
   * Pages at Amazon's ~1000-row cap until exhausted. Optional startHourIst is
   * ignored for row filtering (kept for call-site compatibility).
   */
  getAgeingDrillDownData(
    stationCode: string,
    fromDate: string,
    auth: AmazonAuthContext,
    toDate?: string,
    statuses?: AgeingStatusSelector[],
    startHourIst?: number,
  ): Promise<AgeingPackageDetail[]>;

  getStationLiabilitySummary(stationCode: string, range: DateRange, auth: AmazonAuthContext): Promise<LiabilitySummary>;

  /**
   * Bank-deposits remittance list. `range` is the business-day filter hint;
   * by default the provider fetches a portal lookback ending at max(range end, today).
   * Pass `lockPortalEndToRange: true` to end the portal window at the range end
   * date only (needed for historical multi-chunk CIA coverage).
   */
  getRemittances(
    stationCode: string,
    range: DateRange,
    auth: AmazonAuthContext,
    opts?: { lockPortalEndToRange?: boolean },
  ): Promise<RemittanceEntry[]>;

  /** Shipment-level remittance details for pending trackingId diff. */
  getRemittanceDetailsForExcel(remittanceId: string, auth: AmazonAuthContext): Promise<RemittanceDetails>;
}
