# cash-recon-worker

Cloudflare Worker (Hono) for DropX cash / SCC ops against the Amazon Logistics station portal.

It provides:

1. **Executive UI APIs** — station change (drivers + reconciliation + expected cash) and Run SCC (liability)
2. **Full validate pipeline** — pending recon → remittance match → liability (with Supabase override trail)
3. **Session management** — stored Amazon cookie/key, optional Puppeteer auto-login

All Amazon-backed routes require header **`x-admin-key: <ADMIN_API_KEY>`**. Public routes are only health and the station allowlist.

## Frontend flow (current)

| UI action | API |
|---|---|
| Open / change station | `POST /api/admin/executive/driver-reconciliation` |
| Run SCC | `POST /api/admin/executive/liability-summary` |
| Remittance (later) | `POST /api/admin/executive/remittance` |

Always send:

```http
x-admin-key: <ADMIN_API_KEY>
Content-Type: application/json
```

## Architecture

| Layer | Role |
|---|---|
| `src/providers/StationDataProvider.ts` | Upstream interface (`AmazonLogisticsProvider`) |
| `src/store/*` | Session, overrides, portal credentials (Supabase) |
| `src/validators/*` | Pure check helpers (`pendingRecon`, remittance, liability) |
| `src/services/validationPipeline.ts` | Full validate orchestration |
| `src/session/*` | Auto-login, ensure / refresh |
| `src/routes/executiveAmazon.ts` | Executive station / SCC / remittance endpoints |
| `src/utils/expectedCash.ts` | Sum CASH `receivedAmount` from shipment lists |
| `src/index.ts` | Hono routes + CORS |

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill Supabase + ADMIN_API_KEY + Amazon portal creds
```

Run `sql/schema.sql` in the Supabase SQL editor (`amazon_sessions`, overrides, notifications, `amazon_portal_credentials`).

```bash
npm run typecheck
npm run dev          # local worker + auto session ensure/login
```

## Local development

| Command | What it does |
|---|---|
| `npm run dev` | Starts `wrangler.dev.toml` worker, then ensures a valid Amazon session (Node Puppeteer if needed) |
| `npm run dev:worker` | Worker only (no session bootstrap) |
| `npm run session:login` | Force local Puppeteer login → `POST /api/admin/session` |
| `npm run dev:remote` | Remote wrangler (Browser Rendering available; needs stable network) |

**Important:** Cloudflare Browser Rendering is not available in local Miniflare. Local auto-login uses Node `puppeteer` (`scripts/local-session-login.mjs`). Production uses `@cloudflare/puppeteer` + the `BROWSER` binding.

Scrape station for login capture defaults to **TIRC** (`AMAZON_LOGIN_STATION_CODE`). That is only for opening the cash overview page during login — executive / validate calls always use the `stationCode` from the request body.

## Session management

All `/api/admin/*` routes require `x-admin-key: <ADMIN_API_KEY>`.

### Automated login (preferred)

1. Put portal credentials in `.dev.vars` **or** upsert via API:

```http
PUT /api/admin/credentials
x-admin-key: …
Content-Type: application/json

{
  "email": "portal-user@example.com",
  "password": "…",
  "defaultStationCode": "TIRC",
  "updatedBy": "owner@example.com"
}
```

2. Ensure session:

```bash
npm run dev
# or against a deployed worker:
# POST /api/admin/session/ensure
# POST /api/admin/session/refresh   # force re-login
```

3. Frontend calls executive / validate APIs with `x-admin-key` — no Amazon cookie in the body; the worker uses the shared stored session.

`GET /api/admin/credentials` returns a redacted preview (never the raw password).

### Manual upload (fallback)

If MFA / passkey blocks Puppeteer:

1. Sign in in a browser, open Network for a `…/station/proxyapigateway/data` request
2. Copy the full **Cookie** header and `x-api-usage-key`
3. Or paste `scripts/extract-session.console.js` into DevTools (auto-uploads when the worker is up)

```http
POST /api/admin/session
x-admin-key: …
Content-Type: application/json

{ "cookie": "…", "xApiUsageKey": "…", "uploadedBy": "…" }
```

### Session expiry behaviour

On Amazon 401/403/404, HTML login page, or sign-in redirect during validate:

1. Mark stored session `expired`
2. Attempt one Puppeteer re-login and retry validate
3. On failure, write `AMAZON_LOGIN_FAILED` / `AMAZON_SESSION_EXPIRED` to `owner_notifications` (+ email if Resend is configured)

## API

### Auth

| Header | Required on |
|---|---|
| `x-admin-key` | Every `/api/admin/*` route (all Amazon data + session + credentials) |
| — | `GET /api/health`, `GET /api/stations` only |

Missing/wrong key → `401 { "error": "Unauthorized", "code": "UNAUTHORIZED" }`.

---

### 1. Station change — drivers, reconciliation, expected cash

```http
POST /api/admin/executive/driver-reconciliation
x-admin-key: …
Content-Type: application/json

{ "stationCode": "JDBD", "date": "2026-08-02" }
```

`date` is optional (defaults to today IST). `stationCode` is required and must be allowlisted.

**Upstream Amazon calls**

| Step | Amazon resource |
|---|---|
| Active drivers | `/v1/getDrivers` (`codNAWS`) |
| Reconciliation | `/v1/getDriverReconciliation` (`codNAWS`) |
| Expected cash | `/os/getDrillDownData` (`oculus`) — `lastUpdatedRange` = UTC calendar day in unix seconds (e.g. `2026-08-02` → `1785628800`–`1785715200`) |

**Expected cash** filters `actualPaymentMethod === "CASH"`, maps `driverId` → `drivers[].tasId`, and returns:

```jsonc
{
  "totalReceived": 81943.5,
  "shipmentCount": 54,
  "byDriver": [
    {
      "employeeId": 2000080125595,
      "driverName": "Prakash Thakur / DROP / …",
      "tasId": "ALIY31TUBQNTG",
      "totalReceived": 15383.2,
      "shipmentCount": 12,
      "shipments": [
        {
          "barcode": "371285119030",
          "shipmentNo": "406-6293200-5760313",
          "employeeId": 2000080125595,
          "paymentMethod": "CASH",
          "shipmentStatus": "CASH_AT_STATION",
          "shipmentType": "Delivery",
          "updateDate": "2026-08-02",
          "receivableAmount": { "value": 2408.1 },
          "receivedAmount": { "value": 2847.23 }
        }
      ]
    }
  ]
}
```

| Shipment field | Ageing source |
|---|---|
| `barcode` | `trackingId` |
| `shipmentNo` | `orderingOrderId` |
| `employeeId` | matched driver's `employeeId` (`tasId` = `driverId`) |
| `paymentMethod` | `actualPaymentMethod` |
| `shipmentStatus` | `state` |
| `shipmentType` | `packageType` |
| `updateDate` | date of `lastUpdatedTime` (`YYYY-MM-DD`) |
| `receivableAmount.value` | `orderAmount` (÷100 → INR) |
| `receivedAmount.value` | `receivableAmount` (÷100 → INR) |

Use `expectedCash.totalReceived` / `expectedCash.byDriver` in the UI.

---

### 2. Run SCC — liability summary

```http
POST /api/admin/executive/liability-summary
x-admin-key: …
Content-Type: application/json

{ "stationCode": "JDBD", "date": "2026-08-02" }
```

Calls `/v1/getStationLiabilitySummary` and returns a UI helper check (all cash + mPOS fields ~0).

```jsonc
{
  "status": "ok",
  "stationCode": "JDBD",
  "date": "2026-08-02",
  "summary": {
    "cashSummary": { "expectedAmount": {}, "actualAmount": {}, "shortExcessAmount": {}, "count": 0 },
    "mposSummary": { "amount": {}, "count": 0 }
  },
  "check": {
    "passed": true,
    "nonZeroFields": []
  }
}
```

Gate SCC on `check.passed`. If `false`, show `check.nonZeroFields`.

---

### 3. Remittance (frontend later)

```http
POST /api/admin/executive/remittance
x-admin-key: …
Content-Type: application/json

{ "stationCode": "JDBD", "date": "2026-08-02" }
```

```jsonc
{
  "status": "ok",
  "stationCode": "JDBD",
  "date": "2026-08-02",
  "remittances": [ /* getRemittance / remittanceList */ ],
  "remittanceCount": 3
}
```

---

### 4. Full validate pipeline

```http
POST /api/admin/validate
x-admin-key: …
Content-Type: application/json

{
  "stationCode": "JDBD",
  "date": "2026-07-30",
  "denomination": {
    "total": 133072.0,
    "breakdown": { "500": 200, "200": 100 }
  },
  "overrides": {
    "pendingRecon": { "reason": "…", "overriddenBy": "ops@company.com" }
  }
}
```

Checks (stop at first unresolved failure):

1. **pendingRecon** — every active driver's `overallPendingRecon` ≈ 0  
2. **remittanceMatch** — business-day `CREATED`/`SUBMITTED` remittance sum equals denomination total  
3. **liability** — liability cash + mPOS fields all ≈ 0  

- **200** — `{ status: "passed", steps, runId }`
- **409** — `{ status: "blocked", blockedAt, steps, runId }` (expected business block)
- **401** — bad `x-admin-key`, or Amazon session expired after refresh attempt

---

### Admin route index

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/executive/driver-reconciliation` | Drivers + recon + expected cash (station change) |
| `POST` | `/api/admin/executive/liability-summary` | Liability + `check` (Run SCC) |
| `POST` | `/api/admin/executive/remittance` | Remittance list |
| `POST` | `/api/admin/validate` | Full cash validation pipeline |
| `POST` | `/api/admin/session` | Manual cookie upload |
| `GET` | `/api/admin/session/status` | Session + credentials summary |
| `POST` | `/api/admin/session/ensure` | Probe / refresh if needed |
| `POST` | `/api/admin/session/refresh` | Force Puppeteer re-login |
| `POST` | `/api/admin/amazon/liability-summary` | Smoke-test liability probe |
| `GET`/`PUT` | `/api/admin/credentials` | Portal credentials |
| `GET` | `/api/admin/notifications?unacknowledged=true` | Owner alerts |
| `POST` | `/api/admin/notifications/:id/ack` | Acknowledge alert |

### Other

- `GET /api/health` — liveness
- `GET /api/stations` — allowlisted station codes

## Deploy

### If local `wrangler deploy` fails with `fetch failed`

Auth can succeed while **uploads over ~100KB** are reset on some ISP/VPN paths. Use:

1. **Phone hotspot** (or another network), then `npm run deploy`
2. **GitHub Actions** (recommended) — see below

### GitHub Actions deploy

Workflow: `.github/workflows/deploy.yml` (runs on push to `main` and `workflow_dispatch`).

1. Create an API token: [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Edit Cloudflare Workers**
2. Repo **Settings → Secrets and variables → Actions → Repository secrets**:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID` = `0c1359d755dc6714ead89c7c8e9eb9d1`
3. Push to `main` or **Actions → Deploy Worker → Run workflow**

Local deploy (when the network allows):

```bash
npm run deploy          # uses wrangler deploy --env=""
npm run deploy -- --env staging
npm run tail
```

### Worker secrets (once per environment)

Never commit these; never put them in `wrangler.toml` `[vars]`.

From `.dev.vars` (does not print values):

```bash
node scripts/sync-secrets.mjs --env ""
```

Or one at a time:

```bash
npx wrangler secret put SUPABASE_URL --env=""
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env=""
npx wrangler secret put ADMIN_API_KEY --env=""
npx wrangler secret put AMAZON_PORTAL_EMAIL --env=""
npx wrangler secret put AMAZON_PORTAL_PASSWORD --env=""
# optional email alerts:
npx wrangler secret put RESEND_API_KEY --env=""
npx wrangler secret put OWNER_NOTIFICATION_EMAIL --env=""
npx wrangler secret put NOTIFICATION_FROM_EMAIL --env=""
```

Requirements:

- Cloudflare Workers account (Free can deploy; Paid recommended for Puppeteer CPU + higher Browser Rendering limits)
- **Do not set `[limits].cpu_ms` on Free** — Cloudflare rejects it (`code: 100328`)
- Schema applied in Supabase

After first deploy, call `POST /api/admin/session/ensure` before executive / validate traffic.

## Configuration (`wrangler.toml` `[vars]`)

| Var | Purpose |
|---|---|
| `AMAZON_PROXY_BASE_URL` | Station-portal proxy gateway base URL |
| `BUSINESS_DAY_START_HOUR_IST` | Business-day cutover hour IST (default `0`) |
| `DATA_PROVIDER` | Provider factory key (currently `"amazon"`) |
| `AMAZON_LOGIN_STATION_CODE` | Station for login page scrape only (default `TIRC`) |
| `OWNER_EMAIL` | Notification recipient fallback |

## Known constraints

- MFA / passkey accounts cannot use auto-login — use manual session upload.
- `x-admin-key` is a shared secret, not per-user auth.
- CORS is currently `origin: '*'` — lock down in `src/index.ts` before production.
- Amount equality uses `AMOUNT_EPSILON = 0.01` (`src/utils/number.ts`).
- Expected cash comes from the ageing dashboard (`/os/getDrillDownData`). Only packages with `actualPaymentMethod === CASH` matched to an active driver's `tasId` are included; amounts are converted from paise → INR.
