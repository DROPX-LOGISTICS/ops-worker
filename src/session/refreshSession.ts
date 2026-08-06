import type { Env, AmazonAuthContext, StoredCredential } from '../types';
import { portalAccountKeyForStation, isDedicatedPortalStation } from '../config';
import { createCredentialStore } from '../store/factory';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { createNotifier } from '../notifications/factory';
import { loginAndCaptureSession } from './AmazonPortalLogin';
import { scrapeStationCode } from './scrapeStation';

export type RefreshSessionResult =
  | { ok: true; stored: StoredCredential; source: 'puppeteer'; accountKey: string }
  | {
      ok: false;
      code: 'NO_CREDENTIALS' | 'LOGIN_IN_PROGRESS' | 'LOGIN_FAILED' | 'MFA_REQUIRED' | 'CAPTURE_TIMEOUT' | 'BROWSER_ERROR';
      error: string;
      accountKey: string;
    };

/**
 * Puppeteer login → capture cookie + x-api-usage-key → store active session
 * for the resolved portal account (default or dedicated station account).
 */
export async function refreshAmazonSession(
  env: Env,
  opts: {
    triggeredBy?: string;
    notifyOnFailure?: boolean;
    stationCode?: string;
    accountKey?: string;
  } = {},
): Promise<RefreshSessionResult> {
  const accountKey = opts.accountKey || portalAccountKeyForStation(opts.stationCode);
  const portalStore = new PortalCredentialStore(env);
  const creds = await portalStore.getForLogin(accountKey);
  if (!creds) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      accountKey,
      error:
        `No Amazon portal credentials for account "${accountKey}". ` +
        'PUT /api/admin/credentials with accountKey first.',
    };
  }

  const locked = await portalStore.tryAcquireLoginLock(accountKey, 150);
  if (!locked) {
    return {
      ok: false,
      code: 'LOGIN_IN_PROGRESS',
      accountKey,
      error: `Another Amazon login is already in progress for account "${accountKey}". Retry shortly.`,
    };
  }

  const scrapeStation = isDedicatedPortalStation(opts.stationCode)
    ? (creds.defaultStationCode || opts.stationCode || accountKey).trim().toUpperCase()
    : scrapeStationCode(env, creds.defaultStationCode);
  const triggeredBy = opts.triggeredBy || creds.email || 'auto-refresh';

  try {
    const result = await loginAndCaptureSession(env, {
      email: creds.email,
      password: creds.password,
      stationCode: scrapeStation,
    });

    if (!result.ok) {
      await portalStore.releaseLoginLock({ ok: false, error: result.error }, accountKey);
      if (opts.notifyOnFailure !== false) {
        await notifyLoginFailure(env, result.error, result.code, scrapeStation, accountKey);
      }
      return { ok: false, code: result.code, error: result.error, accountKey };
    }

    const stored = await persistAuth(env, result.auth, triggeredBy, accountKey);
    await portalStore.releaseLoginLock({ ok: true }, accountKey);
    return { ok: true, stored, source: 'puppeteer', accountKey };
  } catch (err) {
    const message = (err as Error).message || 'Unknown login error';
    await portalStore.releaseLoginLock({ ok: false, error: message }, accountKey);
    if (opts.notifyOnFailure !== false) {
      await notifyLoginFailure(env, message, 'BROWSER_ERROR', scrapeStation, accountKey);
    }
    return { ok: false, code: 'BROWSER_ERROR', error: message, accountKey };
  }
}

async function persistAuth(
  env: Env,
  auth: AmazonAuthContext,
  uploadedBy: string,
  accountKey: string,
): Promise<StoredCredential> {
  const store = createCredentialStore(env);
  return store.upload(auth.cookie, auth.xApiUsageKey, uploadedBy, accountKey);
}

async function notifyLoginFailure(
  env: Env,
  error: string,
  code: string,
  scrapeStation: string,
  accountKey: string,
): Promise<void> {
  const notifier = createNotifier(env);
  await notifier
    .notify({
      type: 'AMAZON_LOGIN_FAILED',
      severity: 'critical',
      message:
        `Automatic Amazon login failed for account "${accountKey}" (${code}): ${error}. ` +
        'Update credentials via PUT /api/admin/credentials.',
      meta: { code, scrapeStation, error, accountKey },
    })
    .catch((e) => console.error('notifyLoginFailure failed', e));
}
