// ---------------------------------------------------------------------------
// Cloudflare bindings (env vars + secrets)
// ---------------------------------------------------------------------------
export interface Env {
  AMAZON_PROXY_BASE_URL: string;
  BUSINESS_DAY_START_HOUR_IST: string;
  DATA_PROVIDER: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Shared secret the owner's frontend sends as `x-admin-key` to reach /api/admin/*. */
  ADMIN_API_KEY: string;
  /** Optional — enables email delivery (via Resend) alongside the dashboard notification row. */
  RESEND_API_KEY?: string;
  OWNER_NOTIFICATION_EMAIL?: string;
  NOTIFICATION_FROM_EMAIL?: string;
}

// ---------------------------------------------------------------------------
// Amazon station-portal domain shapes (normalised across the "cod" / legacy
// and "codNAWS" / v1 API variants observed in traffic)
// ---------------------------------------------------------------------------
export interface Money {
  unit: string | null;
  value: number;
}

export interface Driver {
  driverName: string;
  tasId: string | null;
  employeeId: number;
  active?: boolean;
  store: boolean;
}

export interface ReconBreakdownItem {
  trackingId: string;
  paymentMethod: string;
  amount: Money;
  stationTimeZone: string;
  moneyCollectionTime?: number;
  transactionTime?: number;
}

export interface DriverReconciliationEntry {
  store: boolean;
  driverInfo: { name: string; id: string | null };
  providerInfo: { name: string; type: string };
  paymentInfo: {
    method: string | null;
    expected: Money;
    actualCash: Money;
    actualMpos: Money;
    balance: Money;
    variance: Money;
    overallPendingRecon: Money;
    overallPendingReconBreakdownList: ReconBreakdownItem[];
  };
}

export interface LiabilitySummary {
  cashSummary: {
    expectedAmount: Money;
    actualAmount: Money;
    shortExcessAmount: Money;
    count: number;
  };
  mposSummary: {
    amount: Money;
    count: number;
  };
}

export interface RemittanceEntry {
  remittanceCode: string | null;
  remittanceId: string;
  creationDate: number;
  lastUpdated: number;
  submissionDate: number | null;
  createdBy: string;
  submittedBy: string | null;
  status: 'CREATED' | 'SUBMITTED' | string;
  expectedAmount: Money;
  actualAmount: Money;
  paymentMethod: string;
  variance: Money;
}

// ---------------------------------------------------------------------------
// API contract (frontend <-> worker)
// ---------------------------------------------------------------------------
export interface AmazonAuthContext {
  /** Forwarded `cookie` header from an authenticated station-portal session. */
  cookie: string;
  /** Forwarded `x-api-usage-key` header from the station portal. */
  xApiUsageKey: string;
}

// ---------------------------------------------------------------------------
// Stored Amazon session (uploaded by the owner, reused across requests)
// ---------------------------------------------------------------------------
export type SessionStatus = 'active' | 'expired';

export interface StoredCredential {
  id: string;
  cookie: string;
  xApiUsageKey: string;
  uploadedBy: string;
  uploadedAt: string;
  status: SessionStatus;
  expiredAt?: string | null;
}

// ---------------------------------------------------------------------------
// Owner notifications (session expiry, etc.)
// ---------------------------------------------------------------------------
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationPayload {
  type: string;
  message: string;
  severity: NotificationSeverity;
  meta?: Record<string, unknown>;
}

export interface StoredNotification extends NotificationPayload {
  id: string;
  acknowledged: boolean;
  createdAt: string;
}

export interface CashDenominationInput {
  total: number;
  /** Optional note-by-note breakdown, e.g. { "500": 10, "200": 5 }. */
  breakdown?: Record<string, number>;
}

export type CheckName = 'pendingRecon' | 'remittanceMatch' | 'liability';

export interface OverridePayload {
  reason: string;
  overriddenBy: string;
}

export interface ValidateRequestBody {
  stationCode: string;
  /** Business date in YYYY-MM-DD, interpreted in IST. */
  date: string;
  denomination: CashDenominationInput;
  /** Supplied by the frontend once a user has justified a failed check. */
  overrides?: Partial<Record<CheckName, OverridePayload>>;
  /**
   * Optional. If omitted, the worker uses the most recently uploaded
   * session from the CredentialStore (see /api/admin/session). Only pass
   * this explicitly if you want to bypass the stored session for one call.
   */
  auth?: AmazonAuthContext;
}

export interface StepResult {
  name: CheckName;
  status: 'passed' | 'failed' | 'overridden';
  details?: unknown;
}

export interface PipelineResult {
  status: 'passed' | 'blocked';
  stationCode: string;
  date: string;
  blockedAt?: CheckName;
  steps: StepResult[];
  runId?: string;
}