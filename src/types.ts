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
  /**
   * Cloudflare Browser Rendering binding (wrangler `browser.binding = "BROWSER"`).
   * Present on deploy / `wrangler dev --remote`. Absent in local Miniflare —
   * use `npm run session:login` instead for local session capture.
   */
  BROWSER?: Fetcher;
  /**
   * Optional bootstrap credentials. Prefer POST /api/admin/credentials so the
   * owner can edit them without redeploying. Env values are used only when no
   * row exists in amazon_portal_credentials yet.
   */
  AMAZON_PORTAL_EMAIL?: string;
  AMAZON_PORTAL_PASSWORD?: string;
  /** Station used only while scraping cookie/key during auto-login (e.g. TIRC). Not a validate station. */
  AMAZON_LOGIN_STATION_CODE?: string;
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
    /**
     * Pending recon for the requested date.
     * Overridden from ageing `state` (Cash In Associate) when enrichment runs;
     * Amazon's raw value is cumulative and not reliable for historical dates.
     */
    overallPendingRecon: Money;
    overallPendingReconBreakdownList: ReconBreakdownItem[];
  };
  /** Ageing-derived pending (Cash In Associate) for the requested date (INR). */
  pendingReconAmount?: number;
  /** Ageing-derived completed (CASH_AT_STATION) for the requested date (INR). */
  completedReconAmount?: number;
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

export interface RemittanceStationVarianceItem {
  amount: Money;
  reason: string;
  type: string;
}

export interface RemittanceStationVariance {
  transactionId: string | null;
  isVerified: boolean | null;
  stationVarianceList: RemittanceStationVarianceItem[];
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
  ttLink?: string | null;
  stationVariance?: RemittanceStationVariance | null;
}

/** Internal row from ageing `/os/getDrillDownData` (before frontend shipment mapping). */
export interface AgeingPackageDetail {
  trackingId: string;
  driverId: string | null;
  paymentMethod: string;
  actualPaymentMethod: string | null;
  receivableAmount: number;
  orderAmount: number | null;
  state: string | null;
  packageType: string | null;
  lastUpdatedTime: string | null;
  orderingOrderId: string | null;
}

/** Frontend shipment row inside expectedCash (legacy shape). */
export interface ExpectedCashShipment {
  barcode: string;
  shipmentNo: string | null;
  /** Null when ageing driverId is not in getDrivers. */
  employeeId: number | null;
  /** Mapped from ageing `actualPaymentMethod`. */
  paymentMethod: string;
  shipmentStatus: string | null;
  shipmentType: string | null;
  /** Date only from ageing lastUpdatedTime (YYYY-MM-DD). */
  updateDate: string | null;
  /** Order amount from ageing. */
  receivableAmount: { value: number };
  /** Receivable amount from ageing (cash expected). */
  receivedAmount: { value: number };
}

export interface ExpectedCashByDriver {
  /** Null when ageing driverId is not in getDrivers. */
  employeeId: number | null;
  driverName: string;
  /** Ageing driverId / getDrivers tasId. */
  tasId: string | null;
  /** False when driverId was not in the active drivers list. */
  mappedToActiveDriver: boolean;
  totalReceived: number;
  shipmentCount: number;
  shipments: ExpectedCashShipment[];
}

export interface ExpectedCashSummary {
  /** Sum of receivedAmount.value for all CASH packages (mapped + unmapped). */
  totalReceived: number;
  shipmentCount: number;
  byDriver: ExpectedCashByDriver[];
}

/** Shipment row from `/v1/getRemittanceDetailsForExcel`. */
export interface RemittanceShipmentDetail {
  trackingId: string;
  amount: number;
  associateName: string | null;
  station: string | null;
  statusUpdateTimeStamp: string | null;
  depositCode: string | null;
}

export interface RemittanceDetails {
  remittanceId: string;
  remittanceAmount: number;
  actualAmount: number;
  shipments: RemittanceShipmentDetail[];
}

export type RemittanceMatchStatus = 'MATCHED' | 'MATCHED_WINDOW' | 'PENDING' | 'UNRESOLVED';
export type RemittanceMatchMode = 'sameDay' | 'forwardDeposit' | 'backwardPileUp' | 'none';

export interface RemittanceMatchInfo {
  status: RemittanceMatchStatus;
  mode: RemittanceMatchMode;
  window: { from: string; to: string };
  sameDayExpectedCashTotal: number;
  sameDayRemittanceTotalCash: number;
  expectedCashTotal: number;
  remittanceTotalCash: number;
  limitedByRemittanceWindow: boolean;
  analysisRemittances: RemittanceEntry[];
}

export interface PendingLiabilityByDriver {
  driverName: string;
  tasId: string | null;
  employeeId: number | null;
  pendingAmount: number;
  shipments: ExpectedCashShipment[];
}

export interface PendingLiabilityByDay {
  date: string;
  pendingAmount: number;
  byDriver: PendingLiabilityByDriver[];
}

export interface PendingLiabilities {
  pendingTotal: number;
  byDay: PendingLiabilityByDay[];
}

/** Exact trackingId clearance status for an ageing cash shipment. */
export type LedgerShipmentStatus = 'clearedSameDay' | 'forwarded' | 'pending';

export interface RemittanceLedgerShipment {
  trackingId: string;
  shipmentNo: string | null;
  pendingAmount: number;
  keptOnDate: string;
  clearedOnDate: string | null;
  keptDays: number | null;
  status: LedgerShipmentStatus;
  remittanceId: string | null;
  remittanceCode: string | null;
}

export interface RemittanceLedgerDriver {
  driverName: string;
  tasId: string | null;
  employeeId: number | null;
  amount: number;
  shipmentCount: number;
  shipments: RemittanceLedgerShipment[];
}

export interface RemittanceLedgerDay {
  date: string;
  expectedCashTotal: number;
  remittanceTotalCash: number;
  /** expectedCashTotal - remittanceTotalCash (can be negative if remittance exceeds ageing). */
  shortAmount: number;
  carryForwardIn: number;
  /** Amount from this day's ageing still open after same-day remittance match (forwarded + still pending). */
  carryForwardOut: number;
  clearedSameDayAmount: number;
  /** Ageing cash from this day cleared later by exact trackingId. */
  forwardedAmount: number;
  /** Ageing cash from this day with no remittance trackingId match yet. */
  stillPendingAmount: number;
  /** Prior-day forwarded cash cleared by remittance details on this day. */
  clearedFromPriorAmount: number;
  drivers: RemittanceLedgerDriver[];
}

export interface RemittanceLedgerSummary {
  status: RemittanceMatchStatus;
  mode: RemittanceMatchMode;
  window: { from: string; to: string };
  sameDayExpectedCashTotal: number;
  sameDayRemittanceTotalCash: number;
  sameDayShortAmount: number;
  finalPendingTotal: number;
  limitedByRemittanceWindow: boolean;
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
  /** Portal account this session belongs to (`default`, `KDJG`, …). */
  accountKey?: string;
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