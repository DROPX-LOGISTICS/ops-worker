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

Scrape station for login capture defaults to **TIRC** (`AMAZON_LOGIN_STATION_CODE`). That is only for opening the cash overview page — `POST /api/validate` always uses the `stationCode` from the frontend.

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

3. Frontend calls `POST /api/validate` with the real station (e.g. `JDBD`) — no cookie in the body; the worker uses the shared stored session.

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

### `POST /api/validate`

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
- **401** — session expired / login failed after refresh attempt

### Admin

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/session` | Manual cookie upload |
| `GET` | `/api/admin/session/status` | Session + credentials summary |
| `POST` | `/api/admin/session/ensure` | Probe / refresh if needed |
| `POST` | `/api/admin/session/refresh` | Force Puppeteer re-login |
| `POST` | `/api/admin/amazon/liability-summary` | Smoke-test Amazon proxy (`{ "stationCode": "TIRC" }`) |
| `GET`/`PUT` | `/api/admin/credentials` | Portal credentials |
| `GET` | `/api/admin/notifications?unacknowledged=true` | Owner alerts |
| `POST` | `/api/admin/notifications/:id/ack` | Acknowledge alert |

### Other

- `GET /api/health` — liveness
- `GET /api/stations` — allowlisted station codes

## Deploy

Secrets (never commit; never put in `wrangler.toml`):

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ADMIN_API_KEY

# Portal bootstrap (optional if you only use PUT /api/admin/credentials)
wrangler secret put AMAZON_PORTAL_EMAIL
wrangler secret put AMAZON_PORTAL_PASSWORD

# Optional email alerts
wrangler secret put RESEND_API_KEY
wrangler secret put OWNER_NOTIFICATION_EMAIL
wrangler secret put NOTIFICATION_FROM_EMAIL
```

Requirements:

- Workers paid plan with **Browser Rendering** enabled (`browser = { binding = "BROWSER" }` in `wrangler.toml`)
- Schema applied in Supabase

```bash
npm run deploy
npm run tail    # live logs
```

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
