import type { StationDataProvider } from './StationDataProvider';
import type {
  Driver,
  DriverReconciliationEntry,
  LiabilitySummary,
  RemittanceEntry,
  AmazonAuthContext,
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

/**
 * StationDataProvider implementation backed by the internal Amazon
 * Logistics station-portal proxy gateway
 * (POST /station/proxyapigateway/data with a {resourcePath, processName,
 * requestBody} envelope). Resource paths/process names live in
 * src/config.ts so switching API generations is a one-line change.
 */
export class AmazonLogisticsProvider implements StationDataProvider {
  constructor(private readonly baseUrl: string) {}

  private async callProxy<TReq, TRes>(
    resourcePath: string,
    processName: string,
    requestBody: TReq,
    auth: AmazonAuthContext,
  ): Promise<TRes> {
    const envelope: ProxyEnvelope<TReq> = { resourcePath, httpMethod: 'POST', processName, requestBody };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/station/proxyapigateway/data`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
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

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('Amazon station-portal session expired or unauthorized', 401, 'AMAZON_SESSION_EXPIRED');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `Amazon proxy call failed (${resourcePath}): ${res.status} ${text}`.trim(),
        502,
        'PROVIDER_UPSTREAM_ERROR',
      );
    }

    return (await res.json()) as TRes;
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
