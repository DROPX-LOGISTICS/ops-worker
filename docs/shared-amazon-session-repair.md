# Shared Amazon session repair (2026-09-12)

This worker shares Amazon sessions with amazon-edd-worker, cash-recon-worker,
and report-auto-worker. Deploy all three clients together after applying
ops-worker/supabase/migrations/20260912103341_shared_amazon_session_protocol.sql.

## Contract
- Service-role-only Postgres RPCs claim a 300-second account-scoped lease.
- Every automatic publication and release carries the winning UUID.
- Replacing an active session is one transaction, with an idempotent session UUID.
- Once an account adopts v1, legacy direct session/lock writes are rejected.
- Manual session uploads remain supported and supersede in-flight login owners.
- Quota/MFA failures back off for 15 minutes; other failures back off for 60 seconds.
- A database read failure does not mean there is no session; never bootstrap over it.
- Browser closure is requested after 150 seconds; the DB rejects expired owners even
  if a platform/browser operation fails to stop. Upstream HTTP has a 60-second
  timeout, and Supabase requests/body reads a 20-second timeout.
- Existing station scoping, credentials, secrets, status classification and schedules remain.
- Login probes require two consecutive authentication failures before expiring
  the shared session. Network/quota errors remain inconclusive, and diagnostics
  record only failure categories, never cookies, keys or response bodies.

## Verification
Run `pnpm typecheck`, `node scripts/test-amazon-session-client.mjs`,
and `wrangler deploy --dry-run --env=""` in each repository.
The ops-worker repository also contains isolated Postgres protocol tests:
`PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node scripts/test-amazon-session-protocol.mjs`.
No test reads or writes production credentials.

## Release safety
Commit and push first. Record Git SHA and Cloudflare version for every worker.
Preserve existing bindings, cron triggers and secrets. Confirm all six account
sessions and all 38 station source jobs after deployment. A successful build is
not proof that upstream data is fresh.

Do not roll just one worker back to an old direct-write implementation after an
account has adopted v1: the protocol guard intentionally rejects it. Prefer a
forward fix or the last v1-compatible release. If a coordinated full rollback is
needed, stop login writers, back up active-session metadata, and explicitly
migrate all clients/guards together. Never clear authentication cooldowns to
hide an upstream quota or challenge. Retain the last verified observation and
its real time; never manufacture missed historical checkpoints.
