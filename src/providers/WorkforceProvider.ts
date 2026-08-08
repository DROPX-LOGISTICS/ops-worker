import type { WorkforceAssociate, WorkforceAuthContext } from '../types';
import { WORKFORCE_RESOURCES } from '../config';
import { ProviderError } from '../errors';

interface FetchAssociatesRaw {
  tableData?: {
    'dsp-associates-table-data'?: {
      rows?: string[];
    };
  };
}

interface AssociateJsonRow {
  full_name?: string;
  photo_url?: string;
  provider_id?: string;
  transporter_id?: string;
  roles?: string;
  qualifications?: string;
  driver_license_expiration_date?: string;
  personal_phone_number?: string;
  work_phone_number?: string;
  email_address?: string;
  operational_status?: string;
}

function parseAssociateRow(raw: string): WorkforceAssociate | null {
  try {
    const row = JSON.parse(raw) as AssociateJsonRow;
    const transporterId = (row.transporter_id ?? '').trim();
    const fullName = (row.full_name ?? '').trim();
    if (!transporterId || !fullName) return null;
    return {
      transporterId,
      fullName,
      providerId: row.provider_id?.trim() || null,
      roles: row.roles?.trim() || null,
      qualifications: row.qualifications?.trim() || null,
      operationalStatus: row.operational_status?.trim() || null,
      personalPhoneNumber: row.personal_phone_number?.trim() || null,
      workPhoneNumber: row.work_phone_number?.trim() || null,
      emailAddress: row.email_address?.trim() || null,
      driverLicenseExpirationDate: row.driver_license_expiration_date?.trim() || null,
      photoUrl: row.photo_url?.trim() || null,
    };
  } catch {
    return null;
  }
}

/**
 * Client for logistics.amazon.in workforce APIs.
 * Auth is cookie-based (separate from amazonlogistics.eu station portal).
 */
export class WorkforceProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly companyId: string,
  ) {}

  /**
   * Low-level GET helper for future workforce endpoints.
   * Always sends same-origin style headers that match the browser DA console.
   */
  async getJson<T>(
    pathWithQuery: string,
    auth: WorkforceAuthContext,
    refererPath = '/workforce',
  ): Promise<T> {
    const url = pathWithQuery.startsWith('http')
      ? pathWithQuery
      : `${this.baseUrl}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-language': 'en-IN,en;q=0.9',
          cookie: auth.cookie,
          referer: `${this.baseUrl}${refererPath}`,
          origin: this.baseUrl,
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        },
        redirect: 'manual',
      });
    } catch (err) {
      throw new ProviderError(
        `Workforce request failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'WORKFORCE_NETWORK',
      );
    }

    if (res.status === 401 || res.status === 403 || res.status === 302) {
      throw new ProviderError(
        'Workforce session expired or unauthorized',
        res.status === 302 ? 401 : res.status,
        'WORKFORCE_SESSION_EXPIRED',
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(
        `Workforce API error ${res.status}: ${body.slice(0, 200)}`,
        res.status >= 400 && res.status < 600 ? res.status : 502,
        'WORKFORCE_HTTP',
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new ProviderError(
        'Workforce returned HTML (likely login page) — session cookie is stale',
        401,
        'WORKFORCE_SESSION_EXPIRED',
      );
    }

    return (await res.json()) as T;
  }

  /**
   * GET /workforce/api/v1/fetchDSPAssociates
   * Rows arrive as JSON strings inside tableData["dsp-associates-table-data"].rows.
   */
  async fetchDSPAssociates(
    auth: WorkforceAuthContext,
    opts?: {
      station?: string;
      operationalStatuses?: string;
      companyId?: string;
    },
  ): Promise<WorkforceAssociate[]> {
    const companyId = opts?.companyId ?? this.companyId;
    const station = opts?.station ?? 'ALL';
    const operationalStatuses = opts?.operationalStatuses ?? 'ACTIVE,INACTIVE';

    const qs = new URLSearchParams({
      companyId,
      operationalStatuses,
      station,
    });

    const path = `${WORKFORCE_RESOURCES.fetchDSPAssociates}?${qs.toString()}`;
    const referer =
      `/workforce?pageId=da_console_associates&station=${encodeURIComponent(station)}` +
      `&companyId=${encodeURIComponent(companyId)}&tabId=da-console-associates-tab`;

    const raw = await this.getJson<FetchAssociatesRaw>(path, auth, referer);
    const rows = raw.tableData?.['dsp-associates-table-data']?.rows ?? [];
    const associates: WorkforceAssociate[] = [];
    for (const row of rows) {
      const parsed = parseAssociateRow(row);
      if (parsed) associates.push(parsed);
    }
    return associates;
  }
}
