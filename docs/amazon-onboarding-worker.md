# Amazon onboarding worker

Dedicated `amazon-onboarding-worker` scheduler calls the named `AmazonOnboardingSource` RPC entrypoint through a Cloudflare service binding. No public sync endpoint, keys copied to the new Worker, or new browser subscription. Existing SCC/EDD cron expressions and authentication paths are untouched.

Deploy the Workforce `20260920200119_workforce_amazon_observations.sql` migration first, through its GitHub migration workflow. Deploy this repository's primary worker (adds the named entrypoint), then `wrangler.onboarding.toml`. CI performs both Git-sourced releases. The account is the same existing DropX Cloudflare account.

## Owner setup

Workforce → Configuration → Amazon Connection. Enter logistics.amazon.in credentials, enable, and save. Password and the onboarding-only session are encrypted in Supabase Vault. A new or changed password, or explicit Save & test connection, queues one sign-in attempt at the next 30-minute cycle. Pausing stops the scheduler from claiming work. Updating settings fences an in-flight run. Credentials never appear in health responses or logs.

The backend session is distinct from local Chrome and from SCC. No MFA/CAPTCHA solving is implemented. If Amazon challenges the backend login, the connection reports that operator verification is required; do not claim this is automatically resolved. Credentials can be saved without a real applicant or a payable training policy.

Save the exact Amazon profile identifier in an approved associate's Joining plan. The worker reads the Amazon onboarding table, all pagination pages, and stores only linked profile IDs, progress and status. No photos, contact information, documents or bank details are persisted from the portal. Onboarding absence is not interpreted as activation. Only completed scans publish; errors retain old evidence with a stale warning. Changed observations produce immutable history.

## Boundaries

This release does not send invitations, change Amazon settings, complete consent/training, create email accounts, activate Workforce profiles, change rates or transfer money. Those remain separately authorised workflows. A no-linked-profiles run is not proof that a later full roster scan will work. Worker health only proves the scheduler endpoint is deployed; verify a configured account scan separately.

## Tests

`npm run typecheck`; `node --experimental-strip-types --test src/onboarding/observations.test.mjs`; `wrangler deploy --dry-run -c wrangler.onboarding.toml`. Database transaction, secrets contract, tenant, concurrency and audit tests are in the Workforce isolated PGlite suite. No real associate, invitation, BGC charge or payment is created by tests.
