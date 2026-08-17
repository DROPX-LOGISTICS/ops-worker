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
      code:
        | 'NO_CREDENTIALS'
        | 'LOGIN_IN_PROGRESS'
        | 'LOGIN_FAILED'
        | 'MFA_REQUIRED'
        | 'CAPTURE_TIMEOUT'
        | 'BROWSER_ERROR'
        | 'BROWSER_QUOTA';
      error: string;
      accountKey: string;
    };

/**
 * Cloudflare Browser Rendering caps browser-minutes per day and acquisitions
 * per minute; both surface as a 429 from `puppeteer.launch`.
 */
export function isBrowserQuotaError(message: string): boolean {
  return /rate limit exceeded|429|too many requests|browser time/i.test(message);
}

/**
 * How long to stop attempting logins after the account trips the browser quota.
 * A network snapshot walks 38 stations, and every one of them would otherwise
 * launch its own browser, burning the remaining daily budget in seconds and
 * leaving every station failed instead of just the first.
 */
const BROWSER_QUOTA_COOLDOWN_SECONDS = 15 * 60;

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
    // The lock is also used as a quota cooldown, so report which one it is —
    // "login in progress" would send operators looking for a stuck browser.
    if (creds.lastLoginError && isBrowserQuotaError(creds.lastLoginError)) {
      return {
        ok: false,
        code: 'BROWSER_QUOTA',
        accountKey,
        error:
          `Amazon login for account "${accountKey}" is paused until ${creds.loginLockedUntil ?? 'the cooldown ends'} `
          + 'because Cloudflare Browser Rendering returned 429 (daily browser-time budget spent). '
          + 'Upgrade to Workers Paid, or upload a session manually via POST /api/admin/session.',
      };
    }
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
      await releaseAfterFailure(portalStore, result.error, accountKey);
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
    const quota = isBrowserQuotaError(message);
    await releaseAfterFailure(portalStore, message, accountKey);
    if (opts.notifyOnFailure !== false) {
      await notifyLoginFailure(env, message, quota ? 'BROWSER_QUOTA' : 'BROWSER_ERROR', scrapeStation, accountKey);
    }
    return {
      ok: false,
      code: quota ? 'BROWSER_QUOTA' : 'BROWSER_ERROR',
      error: quota
        ? `${message} — Cloudflare Browser Rendering quota is exhausted for this account, so Amazon logins are paused for `
          + `${BROWSER_QUOTA_COOLDOWN_SECONDS / 60} minutes. Upgrade to Workers Paid or wait for the daily reset.`
        : message,
      accountKey,
    };
  }
}

/**
 * Hold the login lock through a quota cooldown so the remaining stations in a
 * network run skip the browser entirely instead of each retrying a launch that
 * cannot succeed.
 */
async function releaseAfterFailure(
  portalStore: PortalCredentialStore,
  error: string,
  accountKey: string,
): Promise<void> {
  if (isBrowserQuotaError(error)) {
    await portalStore.holdLoginLock(error, accountKey, BROWSER_QUOTA_COOLDOWN_SECONDS);
    return;
  }
  await portalStore.releaseLoginLock({ ok: false, error }, accountKey);
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
