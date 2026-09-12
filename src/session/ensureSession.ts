import type { Env, AmazonAuthContext, StoredCredential } from '../types';
import { portalAccountKeyForStation, isDedicatedPortalStation } from '../config';
import { createCredentialStore } from '../store/factory';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { AmazonLogisticsProvider } from '../providers/AmazonLogisticsProvider';
import { validateSessionProbe } from './validateSessionProbe';
import { refreshAmazonSession, type RefreshSessionResult } from './refreshSession';
import { scrapeStationCode } from './scrapeStation';

export { scrapeStationCode };

export type EnsureSessionResult =
  | {
      ok: true;
      auth: AmazonAuthContext;
      credentialId: string;
      source: 'cached' | 'refreshed';
      accountKey: string;
    }
  | {
      ok: false;
      code: string;
      error: string;
      accountKey?: string;
      /** Local Miniflare has no BROWSER binding — run Node puppeteer login. */
      needsLocalLogin?: boolean;
    };

/**
 * Many users + cash-recon / Report-auto / amazon-edd all share one Amazon cookie.
 * Concurrent HTTP is fine once warm. Only Puppeteer login is single-flight —
 * everyone else waits silently until that shared session appears.
 * Never surface LOGIN_IN_PROGRESS to Ops Pulse / end users.
 */
const SHARED_LOGIN_DEADLINE_MS = 120_000;
const SHARED_LOGIN_POLL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1. Reuse active shared session (all workers / concurrent callers).
 * 2. If another worker holds the login lock, wait silently and adopt.
 * 3. Else refresh once; if lock race, keep waiting/adopting — do not fail the UI.
 */
export async function ensureValidAmazonSession(
  env: Env,
  opts: { triggeredBy?: string; notifyOnFailure?: boolean; stationCode?: string } = {},
): Promise<EnsureSessionResult> {
  const accountKey = portalAccountKeyForStation(opts.stationCode);
  const credentialStore = createCredentialStore(env);
  const portalStore = new PortalCredentialStore(env);
  const creds = await portalStore.getForLogin(accountKey);
  const scrapeStation = resolveScrapeStation(env, opts.stationCode, creds?.defaultStationCode);
  const provider = new AmazonLogisticsProvider(env.AMAZON_PROXY_BASE_URL);

  const cached = await tryAdoptActiveSession(
    credentialStore,
    provider,
    scrapeStation,
    accountKey,
    { markExpiredIfInvalid: true },
  );
  if (cached) return cached;

  if (!env.BROWSER) {
    // Still wait briefly — another deployed worker may finish login for us.
    const adopted = await waitForSharedAmazonSession(
      credentialStore,
      portalStore,
      provider,
      scrapeStation,
      accountKey,
      Math.min(60_000, SHARED_LOGIN_DEADLINE_MS),
    );
    if (adopted) return adopted;
    return {
      ok: false,
      code: 'NEEDS_LOCAL_LOGIN',
      accountKey,
      needsLocalLogin: true,
      error:
        `Amazon session missing/invalid for account "${accountKey}" and BROWSER binding is unavailable. ` +
        'Local `npm run dev` will auto-run Node login; on Cloudflare, deploy or use `npm run dev:remote`.',
    };
  }

  const deadline = Date.now() + SHARED_LOGIN_DEADLINE_MS;
  let notifyOnFailure = opts.notifyOnFailure !== false;
  let attemptedRefresh = false;

  while (Date.now() < deadline) {
    const adopted = await tryAdoptActiveSession(
      credentialStore,
      provider,
      scrapeStation,
      accountKey,
      { markExpiredIfInvalid: false },
    );
    if (adopted) return adopted;

    const latestCreds = await portalStore.getForLogin(accountKey);
    if (isLoginLockActive(latestCreds?.loginLockedUntil)) {
      await sleep(SHARED_LOGIN_POLL_MS);
      continue;
    }

    attemptedRefresh = true;
    const refreshed = await refreshAmazonSession(env, {
      triggeredBy: opts.triggeredBy || 'ensure-session',
      notifyOnFailure,
      stationCode: opts.stationCode,
      accountKey,
    });
    notifyOnFailure = false;

    if (refreshed.ok) return mapRefresh(refreshed, accountKey);

    // Contended lock or sibling still logging in — wait silently, never bubble to UI.
    if (refreshed.code === 'LOGIN_IN_PROGRESS') {
      await sleep(SHARED_LOGIN_POLL_MS);
      continue;
    }

    // Quota cooldown: another worker may still publish a session; wait then fail soft.
    if (refreshed.code === 'BROWSER_QUOTA') {
      const afterQuota = await waitForSharedAmazonSession(
        credentialStore,
        portalStore,
        provider,
        scrapeStation,
        accountKey,
        Math.max(0, deadline - Date.now()),
      );
      if (afterQuota) return afterQuota;
      return mapRefresh(refreshed, accountKey);
    }

    return mapRefresh(refreshed, accountKey);
  }

  const lastChance = await tryAdoptActiveSession(
    credentialStore,
    provider,
    scrapeStation,
    accountKey,
    { markExpiredIfInvalid: false },
  );
  if (lastChance) return lastChance;

  console.warn(
    `ensureValidAmazonSession: shared session not ready for ${accountKey} `
      + `(attemptedRefresh=${attemptedRefresh})`,
  );
  return {
    ok: false,
    code: 'SESSION_UNAVAILABLE',
    accountKey,
    error: 'Amazon session is not ready yet. Please try again in a moment.',
  };
}

function isLoginLockActive(loginLockedUntil: string | null | undefined): boolean {
  if (!loginLockedUntil) return false;
  const ms = Date.parse(loginLockedUntil);
  return Number.isFinite(ms) && ms > Date.now();
}

async function tryAdoptActiveSession(
  credentialStore: ReturnType<typeof createCredentialStore>,
  provider: AmazonLogisticsProvider,
  scrapeStation: string,
  accountKey: string,
  opts: { markExpiredIfInvalid: boolean },
): Promise<EnsureSessionResult | null> {
  const active = await credentialStore.getActive(accountKey);
  if (!active) return null;
  const auth = { cookie: active.cookie, xApiUsageKey: active.xApiUsageKey };
  const valid = await probeSession(provider, scrapeStation, auth);
  if (valid) {
    return { ok: true, auth, credentialId: active.id, source: 'cached', accountKey };
  }
  if (opts.markExpiredIfInvalid) {
    await credentialStore
      .markExpired(active.id, accountKey)
      .catch((e) => console.error('markExpired failed', e));
  }
  return null;
}

async function waitForSharedAmazonSession(
  credentialStore: ReturnType<typeof createCredentialStore>,
  portalStore: PortalCredentialStore,
  provider: AmazonLogisticsProvider,
  scrapeStation: string,
  accountKey: string,
  maxWaitMs: number,
): Promise<EnsureSessionResult | null> {
  if (maxWaitMs <= 0) return null;
  const deadline = Date.now() + maxWaitMs;
  let first = true;
  while (Date.now() < deadline) {
    if (!first) await sleep(SHARED_LOGIN_POLL_MS);
    first = false;

    const adopted = await tryAdoptActiveSession(
      credentialStore,
      provider,
      scrapeStation,
      accountKey,
      { markExpiredIfInvalid: false },
    );
    if (adopted) {
      console.log(`ensureValidAmazonSession: adopted shared session for ${accountKey}`);
      return adopted;
    }

    const creds = await portalStore.getForLogin(accountKey);
    // Lock cleared and still no session — stop waiting early so caller can refresh.
    if (!isLoginLockActive(creds?.loginLockedUntil)) {
      const onceMore = await tryAdoptActiveSession(
        credentialStore,
        provider,
        scrapeStation,
        accountKey,
        { markExpiredIfInvalid: false },
      );
      return onceMore;
    }
  }
  return null;
}

function resolveScrapeStation(
  env: Env,
  requestStation?: string,
  credentialDefaultStation?: string,
): string {
  if (isDedicatedPortalStation(requestStation)) {
    return (credentialDefaultStation || requestStation || '').trim().toUpperCase();
  }
  return scrapeStationCode(env, credentialDefaultStation);
}

function mapRefresh(refreshed: RefreshSessionResult, accountKey: string): EnsureSessionResult {
  if (!refreshed.ok) {
    // LOGIN_IN_PROGRESS must not reach product UI — callers use the wait loop.
    if (refreshed.code === 'LOGIN_IN_PROGRESS') {
      return {
        ok: false,
        code: 'SESSION_UNAVAILABLE',
        accountKey,
        error: 'Amazon session is not ready yet. Please try again in a moment.',
      };
    }
    return { ok: false, code: refreshed.code, error: refreshed.error, accountKey };
  }
  return {
    ok: true,
    auth: { cookie: refreshed.stored.cookie, xApiUsageKey: refreshed.stored.xApiUsageKey },
    credentialId: refreshed.stored.id,
    source: 'refreshed',
    accountKey,
  };
}

async function probeSession(
  provider: AmazonLogisticsProvider,
  scrapeStation: string,
  auth: AmazonAuthContext,
): Promise<boolean> {
  return validateSessionProbe(() => provider.getActiveDrivers(scrapeStation, auth));
}

export type { StoredCredential };
