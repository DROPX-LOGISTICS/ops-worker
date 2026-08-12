import type { StationDataProvider, AgeingStatusSelector } from './StationDataProvider';
import type {
  Driver,
  DriverReconciliationEntry,
  LiabilitySummary,
  RemittanceEntry,
  RemittanceDetails,
  RemittanceShipmentDetail,
  AgeingPackageDetail,
  AmazonAuthContext,
} from '../types';
import type { DateRange } from '../utils/dateRange';
import {
  addDaysYmd,
  ageingCalendarYmd,
  getUtcCalendarRangeSeconds,
  getRemittancePortalFetchRange,
  getRemittanceFetchRange,
  todayIstYmd,
  ymdFromIstEpochMs,
} from '../utils/dateRange';
import { ProviderError } from '../errors';
import { ALLOWED_STATIONS, AMAZON_RESOURCES } from '../config';
import { round2 } from '../utils/number';

interface ProxyEnvelope<TReq> {
  resourcePath: string;
  httpMethod: string;
  processName: string;
  requestBody: TReq;
}

interface DriversResponse {
  driverList: Driver[];
}

interface RawReconEntry {
  store?: boolean;
  driverInfo: { driverName?: string; name?: string; tasId?: string | null; id?: string | null; store?: boolean };
  providerInfo: { name: string; type: string };
  paymentInfo: DriverReconciliationEntry['paymentInfo'];
}

interface DriverReconciliationResponse {
  driverReconciliationList: RawReconEntry[];
}

interface RawRemittanceEntry {
  remittanceCode?: string | null;
  remittanceId?: string;
  creationDate?: number;
  lastUpdated?: number;
  submissionDate?: number | null;
  createdBy?: string;
  submittedBy?: string | null;
  status?: string;
  expectedAmount?: RemittanceEntry['expectedAmount'];
  actualAmount?: RemittanceEntry['actualAmount'];
  paymentMethod?: string;
  variance?: RemittanceEntry['variance'];
  ttLink?: string | null;
  stationVariance?: RemittanceEntry['stationVariance'];
}

interface RemittanceResponse {
  remittanceList?: RawRemittanceEntry[];
}

function normaliseRemittance(row: RawRemittanceEntry): RemittanceEntry {
  const submissionDate =
    row.submissionDate == null || row.submissionDate === 0 ? null : Number(row.submissionDate);
  return {
    remittanceCode: row.remittanceCode ?? null,
    remittanceId: row.remittanceId ?? '',
    creationDate: Number(row.creationDate ?? 0),
    lastUpdated: Number(row.lastUpdated ?? 0),
    submissionDate,
    createdBy: row.createdBy ?? '',
    submittedBy: row.submittedBy ?? null,
    status: row.status ?? '',
    expectedAmount: row.expectedAmount ?? { unit: 'INR', value: 0 },
    actualAmount: row.actualAmount ?? { unit: 'INR', value: 0 },
    paymentMethod: row.paymentMethod ?? 'CASH',
    variance: row.variance ?? { unit: 'INR', value: 0 },
    ttLink: row.ttLink ?? null,
    stationVariance: row.stationVariance ?? null,
  };
}

interface RawAgeingPackage {
  trackingId?: string;
  driverId?: string | null;
  paymentMethod?: string | null;
  actualPaymentMethod?: string | null;
  receivableAmount?: string | number | null;
  orderAmount?: string | number | null;
  state?: string | null;
  reason?: string | null;
  statusReason?: string | null;
  packageType?: string | null;
  lastScanBy?: string | null;
  lastUpdatedTime?: string | null;
  orderingOrderId?: string | null;
  stationCode?: string | null;
  dspName?: string | null;
}

interface AgeingDrillDownResponse {
  packageResultList?: RawAgeingPackage[];
}

function parseAmount(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}


function normaliseAgeingPackage(row: RawAgeingPackage): AgeingPackageDetail {
  const reasonRaw = row.reason ?? row.statusReason ?? null;
  return {
    trackingId: row.trackingId ?? '',
    driverId: row.driverId ?? null,
    paymentMethod: (row.paymentMethod ?? '').toUpperCase(),
    actualPaymentMethod: row.actualPaymentMethod
      ? String(row.actualPaymentMethod).toUpperCase()
      : null,
    receivableAmount: parseAmount(row.receivableAmount),
    orderAmount:
      row.orderAmount === null || row.orderAmount === undefined || row.orderAmount === ''
        ? null
        : parseAmount(row.orderAmount),
    state: row.state ?? null,
    reason: reasonRaw ? String(reasonRaw).trim() : null,
    packageType: row.packageType ?? null,
    lastUpdatedTime: row.lastUpdatedTime ?? null,
    orderingOrderId: row.orderingOrderId ?? null,
    stationCode: row.stationCode ? String(row.stationCode).trim().toUpperCase() : null,
    dspName: row.dspName ?? null,
  };
}

/**
 * StationDataProvider implementation backed by the internal Amazon
 * Logistics station-portal proxy gateway
 * (POST /station/proxyapigateway/data with a {resourcePath, processName,
 * requestBody} envelope). Resource paths/process names live in
 * src/config.ts so switching API generations is a one-line change.
 */
export class AmazonLogisticsProvider implements StationDataProvider {
  constructor(private readonly baseUrl: string) { }

  private async callProxy<TReq, TRes>(
    resourcePath: string,
    processName: string,
    requestBody: TReq,
    auth: AmazonAuthContext,
    options?: { refererPath?: string; httpMethod?: string },
  ): Promise<TRes> {
    const envelope: ProxyEnvelope<TReq> = {
      resourcePath,
      httpMethod: options?.httpMethod ?? 'POST',
      processName,
      requestBody,
    };
    const proxyUrl = `${this.baseUrl}/station/proxyapigateway/data`;
    const refererPath = options?.refererPath ?? '/station/dashboard/cashoverview';

    let res: Response;
    try {
      // Mirror the browser XHR headers from the station portal. Without
      // Origin/Referer/User-Agent, Amazon redirects to the /ap/signin HTML
      // page (often via 302 → 200 HTML), which is what produced the
      // "<!doctype is not valid JSON" failure even with a fresh cookie.
      res = await fetch(proxyUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          origin: this.baseUrl,
          referer: `${this.baseUrl}${refererPath}`,
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          cookie: auth.cookie,
          'x-api-usage-key': auth.xApiUsageKey,
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify(envelope),
      });
    } catch (err) {
      throw new ProviderError(
        `Network error calling Amazon proxy (${resourcePath}): ${(err as Error).message}`,
        502,
        'PROVIDER_NETWORK_ERROR',
      );
    }

    // 3xx with redirect:manual — almost always a bounce to /ap/signin.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '(no location)';
      throw new ProviderError(
        `Amazon station-portal redirected (${res.status} → ${location}) — session is likely stale/invalid`,
        401,
        'AMAZON_SESSION_EXPIRED',
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('Amazon station-portal session expired or unauthorized', 401, 'AMAZON_SESSION_EXPIRED');
    }
    // Amazon's gateway 404s (rather than 401) once a session is stale enough
    // — observed in practice, not documented — so treat it the same way:
    // the stored session needs re-uploading, not a retry.
    if (res.status === 404) {
      throw new ProviderError(
        'Amazon station-portal returned 404 — session is likely stale/invalid',
        404,
        'AMAZON_SESSION_EXPIRED',
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const snippet = text.trimStart().startsWith('<')
        ? `HTML error page (${text.includes('Unknown Error') ? 'Unknown Error' : 'non-JSON'})`
        : text.slice(0, 200);
      throw new ProviderError(
        `Amazon proxy call failed (${resourcePath}): ${res.status} ${snippet}`.trim(),
        502,
        'PROVIDER_UPSTREAM_ERROR',
      );
    }

    // Stale/invalid sessions often get an HTML login/challenge page with
    // HTTP 200 instead of 401/404 — parse as text first so we don't blow up
    // with a raw SyntaxError from res.json().
    const raw = await res.text();
    const trimmed = raw.trimStart();
    if (
      trimmed.startsWith('<!doctype') ||
      trimmed.startsWith('<!DOCTYPE') ||
      trimmed.startsWith('<html') ||
      trimmed.startsWith('<HTML')
    ) {
      throw new ProviderError(
        'Amazon station-portal returned HTML instead of JSON — session is likely stale/invalid',
        401,
        'AMAZON_SESSION_EXPIRED',
      );
    }

    try {
      return JSON.parse(raw) as TRes;
    } catch {
      throw new ProviderError(
        `Amazon proxy returned non-JSON body (${resourcePath}): ${raw.slice(0, 200)}`,
        502,
        'PROVIDER_UPSTREAM_ERROR',
      );
    }
  }

  async getActiveDrivers(stationCode: string, auth: AmazonAuthContext): Promise<Driver[]> {
    const { resourcePath, processName } = AMAZON_RESOURCES.getDrivers;
    const data = await this.callProxy<{ stationCode: string; isActive: boolean }, DriversResponse>(
      resourcePath,
      processName,
      { stationCode, isActive: true },
      auth,
    );
    return (data.driverList ?? []).filter((d) => d.active !== false);
  }

  async getDriverReconciliation(
    stationCode: string,
    range: DateRange,
    drivers: Driver[],
    auth: AmazonAuthContext,
  ): Promise<DriverReconciliationEntry[]> {
    if (drivers.length === 0) return [];

    const driverIdentifierList = drivers.map((d) => ({
      employeeId: d.employeeId,
      tasId: d.tasId,
      isStore: d.store,
    }));

    const { resourcePath, processName } = AMAZON_RESOURCES.getDriverReconciliation;
    const data = await this.callProxy<
      { stationCode: string; dateRange: DateRange; driverIdentifierList: typeof driverIdentifierList },
      DriverReconciliationResponse
    >(resourcePath, processName, { stationCode, dateRange: range, driverIdentifierList }, auth);

    // Normalise the v1 shape (driverInfo.driverName/.tasId) into the common
    // { name, id } shape validators rely on.
    return (data.driverReconciliationList ?? []).map((entry) => ({
      store: entry.driverInfo?.store ?? entry.store ?? false,
      driverInfo: {
        name: entry.driverInfo?.driverName ?? entry.driverInfo?.name ?? 'UNKNOWN',
        id: entry.driverInfo?.tasId ?? entry.driverInfo?.id ?? null,
      },
      providerInfo: entry.providerInfo,
      paymentInfo: entry.paymentInfo,
    }));
  }

  /**
   * Ageing export-style fetch: one status per request, paginate via startingIndex.
   * Amazon oculus caps each page around 1000 rows — requesting size=10000 and
   * stopping when batch.length < 10000 drops everything after the first page.
   */
  async getAgeingDrillDownData(
    stationCode: string,
    fromDate: string,
    auth: AmazonAuthContext,
    toDate?: string,
    statuses?: AgeingStatusSelector[],
    _startHourIst = 5,
  ): Promise<AgeingPackageDetail[]> {
    const { resourcePath, processName, httpMethod } = AMAZON_RESOURCES.getAgeingDrillDownData;
    const endYmd = toDate ?? fromDate;
    // Pad so IST/UTC edge rows are present, then keep by calendar lastUpdated date.
    const fetchFrom = addDaysYmd(fromDate, -2);
    const fetchTo = addDaysYmd(endYmd, 2);
    const lastUpdatedRange = getUtcCalendarRangeSeconds(fetchFrom, fetchTo);
    // Amazon portal default/max page size for getDrillDownData.
    const pageSize = 1000;
    const filters = [
      {
        __type: 'TermFilter:http://internal.amazon.com/coral/com.amazon.oculusservice.model.filter/',
        filterMap: { SHIPMENT_TYPE: ['Delivery', 'MFNPickup'] },
      },
      {
        __type: 'RangeFilter:http://internal.amazon.com/coral/com.amazon.oculusservice.model.filter/',
        filterMap: {},
      },
    ];

    // Match ageing CSV export: separate call per status (not one combined map).
    // Sequential (not Promise.all) — keeps peak memory/CPU under CF Worker limits
    // when large stations return multi-thousand-row payloads per status.
    const statusList: AgeingStatusSelector[] =
      statuses && statuses.length > 0
        ? statuses
        : ['Delivered', 'Cash At Station', 'Cash With Associate'];

    const pages: AgeingPackageDetail[][] = [];
    for (const selector of statusList) {
      const status = typeof selector === 'string' ? selector : selector.status;
      const values = typeof selector === 'string' ? [] : selector.values;
      pages.push(
        await this.fetchAgeingStatusPages(
          resourcePath,
          processName,
          httpMethod,
          stationCode,
          status,
          values,
          filters,
          lastUpdatedRange,
          pageSize,
          auth,
        ),
      );
    }

    const requestedCode = stationCode.trim().toUpperCase();
    const today = todayIstYmd();
    // Historical ranges end at yesterday — never keep today's calendar updates.
    const excludeTodayUpdates = endYmd < today;
    const byTrackingId = new Map<string, AgeingPackageDetail>();
    for (const row of pages.flat()) {
      // Mother-station ageing can include sub-station rows.
      // - Same station head → keep
      // - Sub-station on our allowlist → drop (counted on its own station run)
      // - Sub-station NOT on our allowlist → keep under the mother (otherwise lost)
      const rowStation = row.stationCode?.trim().toUpperCase() || null;
      if (rowStation && rowStation !== requestedCode && ALLOWED_STATIONS.has(rowStation)) {
        continue;
      }

      // Excel pivot uses calendar Last Updated date (not 5 AM ops cutoff).
      const updatedYmd = ageingCalendarYmd(row.lastUpdatedTime);
      if (updatedYmd) {
        if (updatedYmd < fromDate || updatedYmd > endYmd) continue;
        if (excludeTodayUpdates && updatedYmd === today) continue;
      } else if (excludeTodayUpdates) {
        // No parseable date — keep only when not in a historical (excl. today) query.
      }

      if (!row.trackingId || byTrackingId.has(row.trackingId)) continue;
      byTrackingId.set(row.trackingId, row);
    }
    return [...byTrackingId.values()];
  }

  private async fetchAgeingStatusPages(
    resourcePath: string,
    processName: string,
    httpMethod: string | undefined,
    stationCode: string,
    status: string,
    statusValues: string[],
    filters: Array<{ __type: string; filterMap: Record<string, unknown> }>,
    lastUpdatedRange: { startTime: number; endTime: number },
    pageSize: number,
    auth: AmazonAuthContext,
  ): Promise<AgeingPackageDetail[]> {
    const out: AgeingPackageDetail[] = [];
    let startingIndex = 0;
    const maxPages = 50;

    for (let page = 0; page < maxPages; page++) {
      const data = await this.callProxy<
        {
          nodeId: string;
          packageStatusMap: Record<string, unknown[]>;
          filters: Array<{ __type: string; filterMap: Record<string, unknown> }>;
          lastUpdatedRange: { startTime: number; endTime: number };
          size: number;
          startingIndex: number;
        },
        AgeingDrillDownResponse
      >(
        resourcePath,
        processName,
        {
          nodeId: stationCode,
          packageStatusMap: { [status]: statusValues },
          filters,
          lastUpdatedRange,
          size: pageSize,
          startingIndex,
        },
        auth,
        { refererPath: '/station/dashboard/ageing', httpMethod },
      );

      const batch = (data.packageResultList ?? []).map(normaliseAgeingPackage);
      out.push(...batch);
      // Full page → more rows may exist. Short/empty page → done.
      if (batch.length < pageSize) break;
      startingIndex += batch.length;
    }

    return out;
  }

  async getStationLiabilitySummary(
    stationCode: string,
    range: DateRange,
    auth: AmazonAuthContext,
  ): Promise<LiabilitySummary> {
    const { resourcePath, processName } = AMAZON_RESOURCES.getStationLiabilitySummary;
    return this.callProxy<{ stationCode: string; dateRange: DateRange }, LiabilitySummary>(
      resourcePath,
      processName,
      { stationCode, dateRange: range },
      auth,
    );
  }

  async getRemittances(
    stationCode: string,
    range: DateRange,
    auth: AmazonAuthContext,
    opts?: { lockPortalEndToRange?: boolean },
  ): Promise<RemittanceEntry[]> {
    const { resourcePath, processName } = AMAZON_RESOURCES.getRemittance;
    const anchorYmd = ymdFromIstEpochMs(range.endTime);
    // Default: end at max(request, today) so next-day deposits stay visible.
    // CIA historical chunks lock the portal end to the chunk anchor only.
    const fetchRange = opts?.lockPortalEndToRange
      ? getRemittanceFetchRange(anchorYmd)
      : getRemittancePortalFetchRange(anchorYmd, todayIstYmd());
    const data = await this.callProxy<{ stationCode: string; dateRange: DateRange }, RemittanceResponse>(
      resourcePath,
      processName,
      { stationCode, dateRange: fetchRange },
      auth,
      { refererPath: '/station/dashboard/bankdeposits' },
    );
    return (data.remittanceList ?? []).map(normaliseRemittance);
  }

  async getRemittanceDetailsForExcel(
    remittanceId: string,
    auth: AmazonAuthContext,
  ): Promise<RemittanceDetails> {
    const { resourcePath, processName } = AMAZON_RESOURCES.getRemittanceDetailsForExcel;
    const data = await this.callProxy<
      { remittanceId: string },
      {
        remittanceDetails?: {
          remittanceAmount?: number;
          actualAmount?: number;
          shipmentInformationList?: Array<{
            trackingId?: string;
            amount?: number;
            associateName?: string | null;
            station?: string | null;
            statusUpdateTimeStamp?: string | null;
            depositCode?: string | null;
          }>;
        };
      }
    >(
      resourcePath,
      processName,
      { remittanceId },
      auth,
      { refererPath: '/station/dashboard/bankdeposits' },
    );

    const details = data.remittanceDetails ?? {};
    const shipments: RemittanceShipmentDetail[] = (details.shipmentInformationList ?? [])
      .map((row) => ({
        trackingId: (row.trackingId ?? '').trim(),
        amount: round2(Number(row.amount ?? 0) || 0),
        associateName: row.associateName ?? null,
        station: row.station ?? null,
        statusUpdateTimeStamp: row.statusUpdateTimeStamp ?? null,
        depositCode: row.depositCode ?? null,
      }))
      .filter((s) => s.trackingId);

    return {
      remittanceId,
      remittanceAmount: round2(Number(details.remittanceAmount ?? 0) || 0),
      actualAmount: round2(Number(details.actualAmount ?? 0) || 0),
      shipments,
    };
  }
}
