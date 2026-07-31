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
  "auth": {
    "cookie": "session-id=...; session-token=...; ...",   // forwarded from the authenticated portal session
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

Before deploying, set the two secrets (never put these in `wrangler.toml`):

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

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

- **Auth is session-based and per-user.** `auth.cookie` / `auth.xApiUsageKey`
  come from an already-authenticated station-portal browser session and are
  forwarded by your frontend on every request — the worker holds no
  long-lived Amazon credentials of its own. Expect `AMAZON_SESSION_EXPIRED`
  (401) responses once that session times out; surface that to the user as
  "please refresh/re-login to the station portal."
- **Lock down CORS** in `src/index.ts` to your actual frontend origin(s)
  before shipping — it's wide open (`origin: '*'`) for now to make local
  integration easier.
- **Epsilon-based zero/equality checks** (`src/utils/number.ts`,
  `AMOUNT_EPSILON = 0.01`) absorb floating point noise seen in the raw API
  responses (e.g. `0.059999999997671694`). Adjust if INR precision
  requirements change.
