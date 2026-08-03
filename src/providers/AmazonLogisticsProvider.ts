import type { StationDataProvider } from './StationDataProvider';
import type {
  Driver,
  DriverReconciliationEntry,
  LiabilitySummary,
  RemittanceEntry,
  ShipmentSettlementDetail,
  AmazonAuthContext,
  Money,
} from '../types';
import type { DateRange } from '../utils/dateRange';
import { ProviderError } from '../errors';
import { AMAZON_RESOURCES } from '../config';

interface ProxyEnvelope<TReq> {
  resourcePath: string;
  httpMethod: 'POST';
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

interface RemittanceResponse {
  remittanceList: RemittanceEntry[];
}

interface RawShipmentRow {
  barcode?: string | null;
  barCode?: string | null;
  shipmentNo?: string | null;
  employeeId?: number;
  employeeName?: string | null;
  driverName?: string | null;
  paymentMethod?: string;
  shipmentStatus?: string | null;
  shipmentType?: string | null;
  updateDate?: string | null;
  receivableAmount?: Money;
  receivedAmount?: Money;
  remittanceCode?: string | null;
  reconciled?: boolean | null;
}

interface ShipmentListResponse {
  shipmentSettlementDetailList?: RawShipmentRow[];
}

function emptyMoney(): Money {
  return { unit: '', value: 0 };
}

function normaliseShipment(row: RawShipmentRow): ShipmentSettlementDetail {
  return {
    barcode: row.barCode ?? row.barcode ?? null,
    shipmentNo: row.shipmentNo ?? null,
    employeeId: row.employeeId ?? 0,
    driverName: row.driverName ?? row.employeeName ?? null,
    paymentMethod: (row.paymentMethod ?? '').toUpperCase(),
    shipmentStatus: row.shipmentStatus ?? null,
    shipmentType: row.shipmentType ?? null,
    updateDate: row.updateDate ?? null,
    receivableAmount: row.receivableAmount ?? emptyMoney(),
    receivedAmount: row.receivedAmount ?? emptyMoney(),
    remittanceCode: row.remittanceCode ?? null,
    reconciled: row.reconciled ?? null,
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
    options?: { refererPath?: string },
  ): Promise<TRes> {
    const envelope: ProxyEnvelope<TReq> = { resourcePath, httpMethod: 'POST', processName, requestBody };
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

  async getDriverShipmentListDetails(
    stationCode: string,
    range: DateRange,
    employeeId: number,
    auth: AmazonAuthContext,
  ): Promise<ShipmentSettlementDetail[]> {
    const { resourcePath, processName } = AMAZON_RESOURCES.getDriverShipmentListDetails;
    // Legacy `cod` body uses driverInfo.employeeId (matches portal Network tab).
    const data = await this.callProxy<
      { stationCode: string; dateRange: DateRange; driverInfo: { employeeId: number } },
      ShipmentListResponse
    >(
      resourcePath,
      processName,
      { stationCode, dateRange: range, driverInfo: { employeeId } },
      auth,
      { refererPath: '/station/dashboard/driverreconciliation' },
    );

    return (data.shipmentSettlementDetailList ?? []).map(normaliseShipment);
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

  async getRemittances(stationCode: string, range: DateRange, auth: AmazonAuthContext): Promise<RemittanceEntry[]> {
    const { resourcePath, processName } = AMAZON_RESOURCES.getRemittance;
    const data = await this.callProxy<{ stationCode: string; dateRange: DateRange }, RemittanceResponse>(
      resourcePath,
      processName,
      { stationCode, dateRange: range },
      auth,
    );
    return data.remittanceList ?? [];
  }
}
