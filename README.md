# cash-recon-worker

Cloudflare Worker that gates a station's cash-denomination submission behind
three sequential checks against the Amazon station portal, with a
Supabase-backed manual override trail:

1. **pendingRecon** — every active driver's `overallPendingRecon` must be 0.
2. **remittanceMatch** — the sum of that business day's `CREATED`/`SUBMITTED`
   remittances must equal the submitted denomination total.
3. **liability** — `getStationLiabilitySummary`'s cash + mPOS fields must all
   be 0.

Checks run in that order and stop at the first unresolved failure. If the
frontend supplies an `overrides.<checkName>` entry with a reason, that
failure is logged to Supabase and the pipeline continues to the next check
instead of stopping.

## Why it's structured this way

- **`src/providers/StationDataProvider.ts`** is the only thing the pipeline
  knows about "where station data comes from." `AmazonLogisticsProvider` is
  the current implementation (calls the station-portal proxy gateway). To
  point this at a different backend — a server you own, a different Amazon
  API generation, a mock for tests — implement the interface and add a case
  in `src/providers/factory.ts`. Nothing in `validators/` or
  `services/validationPipeline.ts` needs to change.
- **`src/store/OverrideStore.ts`** is the same idea for persistence.
  `SupabaseOverrideStore` is the current implementation; swap in Postgres,
  D1, DynamoDB, etc. by implementing the interface and updating
  `src/store/factory.ts`.
- **`src/validators/*`** are pure functions with no framework or network
  dependency — easy to unit test, easy to reuse if this logic ever needs to
  run somewhere other than a Worker (a Node service, a cron job, etc.).
- **`src/services/validationPipeline.ts`** is the only orchestration layer.
  It fetches all upstream data *concurrently* (the driver list and its
  reconciliation are the only dependent pair; liability and remittances are
  independent) before evaluating the three checks in order, so the
  sequential nature of the business logic doesn't cost extra round-trip
  latency.
- **`src/index.ts`** is a thin Hono app — routing and CORS only. Hono was
  chosen because it's built for the Workers runtime (small, fast, no cold
  start overhead) rather than for general portability.

## API

### `POST /api/validate`

```jsonc
{
  "stationCode": "TIRC",
  "date": "2026-07-30",              // business date, YYYY-MM-DD, interpreted in IST
  "denomination": {
    "total": 133072.0,
    "breakdown": { "500": 200, "200": 100 }  // optional, stored for audit only
  },
  "auth": {                          // OPTIONAL — omit to use the stored session (see "Session management" below)
    "cookie": "session-id=...; session-token=...; ...",
    "xApiUsageKey": "scc-boson-api-...:...:..."
  },
  "overrides": {                     // optional — only send once you have a reason for a failed check
    "pendingRecon": { "reason": "Driver X reconciled manually via helpdesk ticket 123", "overriddenBy": "priya@company.com" }
  }
}
```

**Response — 200, all checks passed:**

```jsonc
{
  "status": "passed",
  "stationCode": "TIRC",
  "date": "2026-07-30",
  "steps": [
    { "name": "pendingRecon", "status": "passed", "details": { "passed": true, "failures": [], "totalPending": 0 } },
    { "name": "remittanceMatch", "status": "passed", "details": { "...": "..." } },
    { "name": "liability", "status": "passed", "details": { "...": "..." } }
  ],
  "runId": "b3f1..."
}
```

**Response — 409, blocked (no override supplied for the failing check):**

```jsonc
{
  "status": "blocked",
  "blockedAt": "pendingRecon",
  "steps": [
    {
      "name": "pendingRecon",
      "status": "failed",
      "details": {
        "passed": false,
        "totalPending": 9638.92,
        "failures": [
          { "driverName": "B  BHUPATHI", "driverId": "A350CCAU7RT1JN", "pendingReconAmount": 9638.92, "unit": "INR" }
        ]
      }
    }
  ],
  "runId": "b3f1..."
}
```

The frontend shows `steps[i].details` for the blocked check, collects a
reason, and re-POSTs the same request with
`overrides.pendingRecon = { reason, overriddenBy }` to move past it. The
next call will re-run `pendingRecon` (now overridden and logged) and proceed
to `remittanceMatch`, and so on.

## Session management

[#session-management](#session-management)

The worker holds no long-lived Amazon credentials. Instead, the owner
periodically copies a live session out of an authenticated browser tab and
uploads it once; every `/api/validate` call reuses it until Amazon
invalidates it, at which point the worker flags it and waits for a fresh
upload. All endpoints in this section require an `x-admin-key` header
matching the `ADMIN_API_KEY` secret.

### `POST /api/admin/session`

[#post-apiadminsession](#post-apiadminsession)
```bash
{
"cookie": "session-id=...; session-token=...; ...",
"xApiUsageKey": "scc-boson-api-...:...:...",
"uploadedBy": "owner@yourcompany.com"
}
```

Stores the session and supersedes whatever was active before it. The
easiest way to produce this payload is `scripts/extract-session.console.js`
— paste it into the DevTools console on the logged-in station-portal tab
(after filling in the worker URL / admin key at the top) and click
anything that reloads dashboard data; it captures the cookie and the
`x-api-usage-key` header (which is computed client-side per request, not
stored anywhere readable) and uploads them automatically.

### `GET /api/admin/session/status`

[#get-apiadminsessionstatus](#get-apiadminsessionstatus)

Returns `{ status: "active" | "expired" | "none", uploadedBy, uploadedAt, expiredAt, cookiePreview, xApiUsageKeyPreview }`
(cookie/key values are redacted to their last 6 characters).

### `GET /api/admin/notifications?unacknowledged=true`

[#get-apiadminnotifications](#get-apiadminnotifications)

Returns recent owner-facing alerts (currently just `AMAZON_SESSION_EXPIRED`)
for the dashboard to render. `POST /api/admin/notifications/:id/ack` marks
one as read.

### What happens when the session expires

[#what-happens-when-the-session-expires](#what-happens-when-the-session-expires)

If Amazon's proxy gateway responds `401`/`403` (unauthorized) **or `404`**
(observed in practice once a session goes stale enough), the worker:

1. Returns `401 AMAZON_SESSION_EXPIRED` to the frontend immediately, so the
   in-progress validate call fails loudly rather than silently.
2. Marks the stored session `expired` in `amazon_sessions`.
3. Writes a `critical` row to `owner_notifications` (dashboard alert) and,
   if `RESEND_API_KEY` + `OWNER_NOTIFICATION_EMAIL` are configured, sends an
   email — see `src/notifications/factory.ts` to add another channel
   (Slack webhook, SMS, etc.) without touching anything else.

### `GET /api/stations`
Returns the allowlisted station codes this worker will accept.

### `GET /api/health`
Liveness check.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your Supabase project values
```

Run the SQL in `sql/schema.sql` against your Supabase project (SQL editor).

```bash
npm run dev       # local dev via wrangler
npm run typecheck
```

Before deploying, set these secrets (never put them in `wrangler.toml`):

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ADMIN_API_KEY            # generate with: openssl rand -hex 32

# Optional — only needed if you want email alerts in addition to the
# dashboard notification row when the Amazon session expires:
wrangler secret put RESEND_API_KEY
wrangler secret put OWNER_NOTIFICATION_EMAIL
wrangler secret put NOTIFICATION_FROM_EMAIL
```

After deploying, upload the first Amazon session (see "Session management"
below) before hitting `/api/validate` — without one it returns
`400 NO_STORED_SESSION`.

```bash
npm run deploy
```

## Configuration knobs (`wrangler.toml` `[vars]`)

| Var | Purpose |
|---|---|
| `AMAZON_PROXY_BASE_URL` | Base URL of the station-portal proxy gateway. |
| `BUSINESS_DAY_START_HOUR_IST` | Hour (IST, 0–23) a business day starts at. Default `0` (midnight IST), reverse-derived from observed `dateRange` pairs in the portal's own traffic — confirm with ops if a different cutover is used. |
| `DATA_PROVIDER` | Which `StationDataProvider` `factory.ts` returns. Currently only `"amazon"`. |

## Known constraints / things to revisit

- **Auth is session-based, not a long-lived credential.** The worker holds
  no Amazon credentials of its own — only whatever the owner last uploaded
  via `POST /api/admin/session`. Expect `AMAZON_SESSION_EXPIRED` (401)
  responses once that session times out (Amazon has also been observed
  returning a bare `404` for a stale session, which is treated the same
  way); when that happens the worker marks the stored session `expired`
  and raises an `owner_notifications` alert (+ email if configured) rather
  than requiring the frontend to detect it itself. Re-run
  `scripts/extract-session.console.js` to recover.
- **Admin routes are a shared secret, not per-user auth.** `x-admin-key`
  is a single value shared by whoever manages sessions/notifications —
  fine for one owner, but swap for real auth if more than one person needs
  scoped access.
- **Lock down CORS** in `src/index.ts` to your actual frontend origin(s)
  before shipping — it's wide open (`origin: '*'`) for now to make local
  integration easier.
- **Epsilon-based zero/equality checks** (`src/utils/number.ts`,
  `AMOUNT_EPSILON = 0.01`) absorb floating point noise seen in the raw API
  responses (e.g. `0.059999999997671694`). Adjust if INR precision
  requirements change.