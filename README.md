# cash-recon-worker

Cloudflare Worker (Hono) that gates a station cash-denomination submission behind three sequential Amazon Logistics station-portal checks, with a Supabase override trail:

1. **pendingRecon** — every active driver's `overallPendingRecon` must be 0
2. **remittanceMatch** — business-day `CREATED`/`SUBMITTED` remittance sum must equal denomination total
3. **liability** — `getStationLiabilitySummary` cash + mPOS fields must all be 0

Checks stop at the first unresolved failure. An `overrides.<checkName>` reason logs the failure and continues.

## Architecture

| Layer | Role |
|---|---|
| `src/providers/StationDataProvider.ts` | Upstream data interface (`AmazonLogisticsProvider` today) |
| `src/store/*` | Session, overrides, portal credentials (Supabase) |
| `src/validators/*` | Pure check functions |
| `src/services/validationPipeline.ts` | Concurrent fetch + ordered evaluation |
| `src/session/*` | Auto-login, session ensure/refresh |
| `src/index.ts` | Hono routes + CORS |

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill Supabase + ADMIN_API_KEY + Amazon portal creds
```

Run `sql/schema.sql` in the Supabase SQL editor (includes `amazon_sessions`, overrides, notifications, and `amazon_portal_credentials`).

```bash
npm run typecheck
npm run dev          # local worker + auto session ensure/login
```

## Local development

| Command | What it does |
|---|---|
| `npm run dev` | Starts `wrangler.dev.toml` worker, then ensures a valid Amazon session (Node Puppeteer login if needed) |
| `npm run dev:worker` | Worker only (no session bootstrap) |
| `npm run session:login` | Force local Puppeteer login → `POST /api/admin/session` |
| `npm run dev:remote` | Remote wrangler (needs network; Browser Rendering available) |

**Important:** Cloudflare Browser Rendering is not available in local Miniflare. Local auto-login uses Node `puppeteer` (`scripts/local-session-login.mjs`). Production uses `@cloudflare/puppeteer` + the `BROWSER` binding.

Scrape station for login capture defaults to **TIRC** (`AMAZON_LOGIN_STATION_CODE`). That is only for opening the cash overview page — `POST /api/admin/validate` always uses the `stationCode` from the frontend.

## Session management

All `/api/admin/*` routes require header `x-admin-key: <ADMIN_API_KEY>`.

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

3. Frontend calls `POST /api/admin/validate` with `x-admin-key` and the real station (e.g. `JDBD`) — no cookie in the body; the worker uses the shared stored session.

`GET /api/admin/credentials` returns a redacted preview (never the raw password).

### Manual upload (fallback)

If MFA / passkey blocks Puppeteer:

1. Sign in in a browser, open Network for a `…/station/proxyapigateway/data` request
2. Copy the full **Cookie** header and `x-api-usage-key`
3. Or paste `scripts/extract-session.console.js` into DevTools (auto-uploads when the worker is up)

```http
POST /api/admin/session
{ "cookie": "…", "xApiUsageKey": "…", "uploadedBy": "…" }
```

### Session expiry behaviour

On Amazon 401/403/404, HTML login page, or sign-in redirect:

1. Mark stored session `expired`
2. Attempt one Puppeteer re-login and retry validate
3. On failure, write `AMAZON_LOGIN_FAILED` / `AMAZON_SESSION_EXPIRED` to `owner_notifications` (+ email if Resend is configured)

## API

### Executive Reconciliation (frontend)

Require header `x-admin-key: <ADMIN_API_KEY>` (same as other `/api/admin/*` routes).

Use these when the ops UI loads / changes station, then when the user submits cash.

#### 1. Station change / open Executive Reconciliation — drivers + pending recon

```http
POST /api/admin/executive/driver-reconciliation
x-admin-key: …
Content-Type: application/json

{ "stationCode": "JDBD", "date": "2026-08-02" }
```

**200 response:**

```jsonc
{
  "status": "ok",
  "stationCode": "JDBD",
  "date": "2026-08-02",
  "dateRange": { "startTime": …, "endTime": … },
  "drivers": [ /* getDrivers / driverList */ ],
  "driverCount": 12,
  "reconciliation": [ /* getDriverReconciliation list */ ],
  "reconciliationCount": 12
}
```

Call this whenever the executive selects or changes `stationCode`.

#### 2. Submit cash & run SCC — remittances

```http
POST /api/admin/executive/remittance
x-admin-key: …
Content-Type: application/json

{ "stationCode": "JDBD", "date": "2026-08-02" }
```

**200 response:**

```jsonc
{
  "status": "ok",
  "stationCode": "JDBD",
  "date": "2026-08-02",
  "remittances": [ /* getRemittance / remittanceList */ ],
  "remittanceCount": 3
}
```

Both use the **stored Amazon session**. Without a valid `x-admin-key` they return `401`. Ensure a portal session first via `/api/admin/session/ensure` if needed.

### `POST /api/admin/validate`

Requires `x-admin-key` (same as all other Amazon-backed routes).

```jsonc
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

- **200** — `{ status: "passed", steps, runId }`
- **409** — `{ status: "blocked", blockedAt, steps, runId }` (expected business block, e.g. pending recon)
- **401** — missing/invalid `x-admin-key`, or Amazon session expired / login failed after refresh attempt

### Admin

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/validate` | Full cash validation pipeline (Amazon) |
| `POST` | `/api/admin/session` | Manual cookie upload |
| `GET` | `/api/admin/session/status` | Session + credentials summary |
| `POST` | `/api/admin/session/ensure` | Probe / refresh if needed |
| `POST` | `/api/admin/session/refresh` | Force Puppeteer re-login |
| `POST` | `/api/admin/amazon/liability-summary` | Smoke-test Amazon proxy (`{ "stationCode": "TIRC" }`) |
| `POST` | `/api/admin/executive/driver-reconciliation` | Drivers + reconciliation for station change |
| `POST` | `/api/admin/executive/remittance` | Remittance list for cash submit / SCC |
| `GET`/`PUT` | `/api/admin/credentials` | Portal credentials |
| `GET` | `/api/admin/notifications?unacknowledged=true` | Owner alerts |
| `POST` | `/api/admin/notifications/:id/ack` | Acknowledge alert |

### Other

- `GET /api/health` — liveness
- `GET /api/stations` — allowlisted station codes

## Deploy

### If local `wrangler deploy` fails with `fetch failed`

Your machine can auth (`wrangler whoami`) but **uploads over ~100KB are reset** on some ISP/VPN/antivirus paths. Re-login does not fix that. Use either:

1. **Phone hotspot** (or another network), then `npm run deploy`
2. **GitHub Actions** (recommended on this network) — see below

### GitHub Actions deploy

1. Create an API token: [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → template **Edit Cloudflare Workers** (needs Workers Scripts Edit + Account read).
2. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — `0c1359d755dc6714ead89c7c8e9eb9d1`
3. Push to `main` or run **Actions → Deploy Worker → Run workflow**.

Local deploy (when the network allows):

```bash
npm run deploy          # production (top-level env)
npm run deploy -- --env staging
npm run tail
```

### Worker secrets (set once per environment)

Never commit these; never put them in `wrangler.toml` `[vars]`:

```bash
npx wrangler secret put SUPABASE_URL --env=""
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env=""
npx wrangler secret put ADMIN_API_KEY --env=""

# Portal bootstrap (optional if you only use PUT /api/admin/credentials)
npx wrangler secret put AMAZON_PORTAL_EMAIL --env=""
npx wrangler secret put AMAZON_PORTAL_PASSWORD --env=""

# Optional email alerts
npx wrangler secret put RESEND_API_KEY --env=""
npx wrangler secret put OWNER_NOTIFICATION_EMAIL --env=""
npx wrangler secret put NOTIFICATION_FROM_EMAIL --env=""
```

Requirements:

- Cloudflare Workers account (Free can deploy; Paid recommended for Puppeteer CPU + higher Browser Rendering limits)
- **Do not set `[limits].cpu_ms` on Free** — Cloudflare rejects it (`code: 100328`)
- Schema applied in Supabase

After first deploy, call `POST /api/admin/session/ensure` (or store credentials + refresh) before validate traffic.

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
