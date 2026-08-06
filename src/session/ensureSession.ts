import type { Env, AmazonAuthContext, StoredCredential } from '../types';
import { portalAccountKeyForStation, isDedicatedPortalStation } from '../config';
import { createCredentialStore } from '../store/factory';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { AmazonLogisticsProvider } from '../providers/AmazonLogisticsProvider';
import { ProviderError } from '../errors';
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
 * 1. Resolve portal account from request station (default vs dedicated).
 * 2. If an active session for that account exists, probe Amazon.
 * 3. Otherwise auto-login with that account's credentials.
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

  const active = await credentialStore.getActive(accountKey);
  if (active) {
    const auth = { cookie: active.cookie, xApiUsageKey: active.xApiUsageKey };
    const valid = await probeSession(provider, scrapeStation, auth);
    if (valid) {
      return { ok: true, auth, credentialId: active.id, source: 'cached', accountKey };
    }
    await credentialStore
      .markExpired(active.id, accountKey)
      .catch((e) => console.error('markExpired failed', e));
  }

  if (!env.BROWSER) {
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

  const refreshed = await refreshAmazonSession(env, {
    triggeredBy: opts.triggeredBy || 'ensure-session',
    notifyOnFailure: opts.notifyOnFailure !== false,
    stationCode: opts.stationCode,
    accountKey,
  });

  return mapRefresh(refreshed, accountKey);
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
  try {
    await provider.getActiveDrivers(scrapeStation, auth);
    return true;
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'AMAZON_SESSION_EXPIRED') {
      return false;
    }
    console.warn('ensureValidAmazonSession: probe non-auth error, reusing session', err);
    return true;
  }
}

export type { StoredCredential };
