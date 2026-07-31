import type { Env, AmazonAuthContext, StoredCredential } from '../types';
import { createCredentialStore } from '../store/factory';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { AmazonLogisticsProvider } from '../providers/AmazonLogisticsProvider';
import { ProviderError } from '../errors';
import { refreshAmazonSession, type RefreshSessionResult } from './refreshSession';
import { scrapeStationCode } from './scrapeStation';

export { scrapeStationCode };

export type EnsureSessionResult =
  | { ok: true; auth: AmazonAuthContext; credentialId: string; source: 'cached' | 'refreshed' }
  | {
      ok: false;
      code: string;
      error: string;
      /** Local Miniflare has no BROWSER binding — run Node puppeteer login. */
      needsLocalLogin?: boolean;
    };

/**
 * 1. If an active session exists, probe Amazon (lightweight getDrivers on the
 *    scrape station). Valid → reuse.
 * 2. Otherwise auto-login (Puppeteer) using scrape-station URL only.
 * 3. Login failure → notify owner (via refreshAmazonSession).
 */
export async function ensureValidAmazonSession(
  env: Env,
  opts: { triggeredBy?: string; notifyOnFailure?: boolean } = {},
): Promise<EnsureSessionResult> {
  const credentialStore = createCredentialStore(env);
  const portalStore = new PortalCredentialStore(env);
  const creds = await portalStore.getForLogin();
  const scrapeStation = scrapeStationCode(env, creds?.defaultStationCode);
  const provider = new AmazonLogisticsProvider(env.AMAZON_PROXY_BASE_URL);

  const active = await credentialStore.getActive();
  if (active) {
    const auth = { cookie: active.cookie, xApiUsageKey: active.xApiUsageKey };
    const valid = await probeSession(provider, scrapeStation, auth);
    if (valid) {
      return { ok: true, auth, credentialId: active.id, source: 'cached' };
    }
    await credentialStore.markExpired(active.id).catch((e) => console.error('markExpired failed', e));
  }

  if (!env.BROWSER) {
    return {
      ok: false,
      code: 'NEEDS_LOCAL_LOGIN',
      needsLocalLogin: true,
      error:
        'Amazon session missing/invalid and BROWSER binding is unavailable. ' +
        'Local `npm run dev` will auto-run Node login; on Cloudflare, deploy or use `npm run dev:remote`.',
    };
  }

  const refreshed = await refreshAmazonSession(env, {
    triggeredBy: opts.triggeredBy || 'ensure-session',
    notifyOnFailure: opts.notifyOnFailure !== false,
  });

  return mapRefresh(refreshed);
}

function mapRefresh(refreshed: RefreshSessionResult): EnsureSessionResult {
  if (!refreshed.ok) {
    return { ok: false, code: refreshed.code, error: refreshed.error };
  }
  return {
    ok: true,
    auth: { cookie: refreshed.stored.cookie, xApiUsageKey: refreshed.stored.xApiUsageKey },
    credentialId: refreshed.stored.id,
    source: 'refreshed',
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
    // Transient network / upstream errors: treat as still usable and let the
    // real validate call surface the problem.
    console.warn('ensureValidAmazonSession: probe non-auth error, reusing session', err);
    return true;
  }
}

export type { StoredCredential };
