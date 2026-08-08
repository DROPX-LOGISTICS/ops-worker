import type { Env, StoredWorkforceSession, WorkforceAuthContext } from '../types';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import { createWorkforceSessionStore } from '../store/factory';
import { createNotifier } from '../notifications/factory';
import { loginAndCaptureWorkforceSession } from './WorkforcePortalLogin';
import {
  getWorkforcePortalCredentials,
  WorkforceLoginStateStore,
} from './workforceCredentials';

export type RefreshWorkforceSessionResult =
  | { ok: true; stored: StoredWorkforceSession; source: 'puppeteer'; accountKey: string }
  | {
      ok: false;
      code:
        | 'NO_CREDENTIALS'
        | 'LOGIN_IN_PROGRESS'
        | 'LOGIN_FAILED'
        | 'MFA_REQUIRED'
        | 'CAPTCHA_REQUIRED'
        | 'CAPTURE_TIMEOUT'
        | 'BROWSER_ERROR';
      error: string;
      accountKey: string;
    };

/**
 * Puppeteer login → capture logistics.amazon.in cookies → store active workforce session.
 */
export async function refreshWorkforceSession(
  env: Env,
  opts: {
    triggeredBy?: string;
    notifyOnFailure?: boolean;
    accountKey?: string;
  } = {},
): Promise<RefreshWorkforceSessionResult> {
  const accountKey = opts.accountKey?.trim() || DEFAULT_PORTAL_ACCOUNT;
  const creds = getWorkforcePortalCredentials(env);
  if (!creds) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      accountKey,
      error:
        'Set WORKFORCE_PORTAL_EMAIL and WORKFORCE_PORTAL_PASSWORD in Worker secrets / .dev.vars.',
    };
  }

  const state = new WorkforceLoginStateStore(env);
  const locked = await state.tryAcquireLoginLock(accountKey, 150);
  if (!locked) {
    return {
      ok: false,
      code: 'LOGIN_IN_PROGRESS',
      accountKey,
      error: `Another workforce login is already in progress for "${accountKey}". Retry shortly.`,
    };
  }

  const triggeredBy = opts.triggeredBy || creds.email || 'workforce-auto-refresh';

  try {
    const result = await loginAndCaptureWorkforceSession(env, {
      email: creds.email,
      password: creds.password,
    });

    if (!result.ok) {
      await state.releaseLoginLock({ ok: false, error: result.error }, accountKey);
      if (opts.notifyOnFailure !== false) {
        await notifyWorkforceLoginFailure(env, result.error, result.code, accountKey);
      }
      return { ok: false, code: result.code, error: result.error, accountKey };
    }

    const stored = await persistWorkforceAuth(env, result.auth, triggeredBy, accountKey);
    await state.releaseLoginLock({ ok: true }, accountKey);
    return { ok: true, stored, source: 'puppeteer', accountKey };
  } catch (err) {
    const message = (err as Error).message || 'Unknown workforce login error';
    await state.releaseLoginLock({ ok: false, error: message }, accountKey);
    if (opts.notifyOnFailure !== false) {
      await notifyWorkforceLoginFailure(env, message, 'BROWSER_ERROR', accountKey);
    }
    return { ok: false, code: 'BROWSER_ERROR', error: message, accountKey };
  }
}

async function persistWorkforceAuth(
  env: Env,
  auth: WorkforceAuthContext,
  uploadedBy: string,
  accountKey: string,
): Promise<StoredWorkforceSession> {
  const store = createWorkforceSessionStore(env);
  return store.upload(auth.cookie, uploadedBy, accountKey);
}

async function notifyWorkforceLoginFailure(
  env: Env,
  error: string,
  code: string,
  accountKey: string,
): Promise<void> {
  const notifier = createNotifier(env);
  await notifier
    .notify({
      type: 'AMAZON_LOGIN_FAILED',
      severity: 'critical',
      message:
        `Automatic workforce (logistics.amazon.in) login failed for "${accountKey}" (${code}): ${error}. ` +
        'Check WORKFORCE_PORTAL_EMAIL / PASSWORD or upload cookies via PUT /api/admin/workforce/session.',
      meta: { code, error, accountKey, portal: 'workforce' },
    })
    .catch((e) => console.error('notifyWorkforceLoginFailure failed', e));
}
