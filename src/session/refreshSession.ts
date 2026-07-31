import type { Env, AmazonAuthContext, StoredCredential } from '../types';
import { createCredentialStore } from '../store/factory';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { createNotifier } from '../notifications/factory';
import { loginAndCaptureSession } from './AmazonPortalLogin';
import { scrapeStationCode } from './scrapeStation';

export type RefreshSessionResult =
  | { ok: true; stored: StoredCredential; source: 'puppeteer' }
  | {
      ok: false;
      code: 'NO_CREDENTIALS' | 'LOGIN_IN_PROGRESS' | 'LOGIN_FAILED' | 'MFA_REQUIRED' | 'CAPTURE_TIMEOUT' | 'BROWSER_ERROR';
      error: string;
    };

/**
 * Puppeteer login → capture cookie + x-api-usage-key → store active session.
 * Always scrapes via AMAZON_LOGIN_STATION_CODE / credentials.defaultStationCode
 * (e.g. TIRC) — never the frontend's validate stationCode.
 */
export async function refreshAmazonSession(
  env: Env,
  opts: { triggeredBy?: string; notifyOnFailure?: boolean } = {},
): Promise<RefreshSessionResult> {
  const portalStore = new PortalCredentialStore(env);
  const creds = await portalStore.getForLogin();
  if (!creds) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      error: 'No Amazon portal credentials configured. PUT /api/admin/credentials first.',
    };
  }

  const locked = await portalStore.tryAcquireLoginLock(150);
  if (!locked) {
    return {
      ok: false,
      code: 'LOGIN_IN_PROGRESS',
      error: 'Another Amazon login is already in progress. Retry shortly.',
    };
  }

  const scrapeStation = scrapeStationCode(env, creds.defaultStationCode);
  const triggeredBy = opts.triggeredBy || creds.email || 'auto-refresh';

  try {
    const result = await loginAndCaptureSession(env, {
      email: creds.email,
      password: creds.password,
      stationCode: scrapeStation,
    });

    if (!result.ok) {
      await portalStore.releaseLoginLock({ ok: false, error: result.error });
      if (opts.notifyOnFailure !== false) {
        await notifyLoginFailure(env, result.error, result.code, scrapeStation);
      }
      return { ok: false, code: result.code, error: result.error };
    }

    const stored = await persistAuth(env, result.auth, triggeredBy);
    await portalStore.releaseLoginLock({ ok: true });
    return { ok: true, stored, source: 'puppeteer' };
  } catch (err) {
    const message = (err as Error).message || 'Unknown login error';
    await portalStore.releaseLoginLock({ ok: false, error: message });
    if (opts.notifyOnFailure !== false) {
      await notifyLoginFailure(env, message, 'BROWSER_ERROR', scrapeStation);
    }
    return { ok: false, code: 'BROWSER_ERROR', error: message };
  }
}

async function persistAuth(env: Env, auth: AmazonAuthContext, uploadedBy: string): Promise<StoredCredential> {
  const store = createCredentialStore(env);
  return store.upload(auth.cookie, auth.xApiUsageKey, uploadedBy);
}

async function notifyLoginFailure(env: Env, error: string, code: string, scrapeStation: string): Promise<void> {
  const notifier = createNotifier(env);
  await notifier
    .notify({
      type: 'AMAZON_LOGIN_FAILED',
      severity: 'critical',
      message: `Automatic Amazon station-portal login failed (${code}): ${error}. Update credentials via PUT /api/admin/credentials.`,
      meta: { code, scrapeStation, error },
    })
    .catch((e) => console.error('notifyLoginFailure failed', e));
}
