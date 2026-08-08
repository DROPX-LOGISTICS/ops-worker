import type { Env, WorkforceAuthContext } from '../types';
import { DEFAULT_PORTAL_ACCOUNT, workforceBaseUrl, workforceCompanyId } from '../config';
import { createWorkforceSessionStore } from '../store/factory';
import { WorkforceProvider } from '../providers/WorkforceProvider';
import { ProviderError } from '../errors';
import { refreshWorkforceSession } from './refreshWorkforceSession';
import { getWorkforcePortalCredentials } from './workforceCredentials';

function createProvider(env: Env): WorkforceProvider {
  return new WorkforceProvider(workforceBaseUrl(env), workforceCompanyId(env));
}

export type EnsureWorkforceSessionResult =
  | {
      ok: true;
      auth: WorkforceAuthContext;
      sessionId: string;
      source: 'cached' | 'refreshed';
      accountKey: string;
      associateCount?: number;
    }
  | {
      ok: false;
      code: string;
      error: string;
      accountKey: string;
      needsLocalLogin?: boolean;
    };

/**
 * 1. Probe active workforce cookie with fetchDSPAssociates.
 * 2. On miss/expiry, Puppeteer-login using WORKFORCE_PORTAL_* env creds.
 */
export async function ensureValidWorkforceSession(
  env: Env,
  opts: {
    triggeredBy?: string;
    notifyOnFailure?: boolean;
    accountKey?: string;
    /** When true, skip probe and force Puppeteer refresh. */
    forceRefresh?: boolean;
  } = {},
): Promise<EnsureWorkforceSessionResult> {
  const accountKey = opts.accountKey?.trim() || DEFAULT_PORTAL_ACCOUNT;
  const store = createWorkforceSessionStore(env);
  const provider = createProvider(env);

  if (!opts.forceRefresh) {
    const active = await store.getActive(accountKey);
    if (active?.cookie) {
      const auth = { cookie: active.cookie };
      const probe = await probeWorkforce(provider, auth);
      if (probe.ok) {
        return {
          ok: true,
          auth,
          sessionId: active.id,
          source: 'cached',
          accountKey,
          associateCount: probe.associateCount,
        };
      }
      await store.markExpired(active.id).catch((e) => console.error('workforce markExpired failed', e));
    }
  }

  if (!getWorkforcePortalCredentials(env)) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      accountKey,
      error:
        'Workforce session missing/invalid and WORKFORCE_PORTAL_EMAIL / PASSWORD are not set.',
    };
  }

  if (!env.BROWSER) {
    return {
      ok: false,
      code: 'NEEDS_LOCAL_LOGIN',
      accountKey,
      needsLocalLogin: true,
      error:
        'Workforce session missing/invalid and BROWSER binding is unavailable. ' +
        'Run `npm run workforce:login` locally, or use `npm run dev:remote` / deploy.',
    };
  }

  const refreshed = await refreshWorkforceSession(env, {
    triggeredBy: opts.triggeredBy || 'ensure-workforce-session',
    notifyOnFailure: opts.notifyOnFailure !== false,
    accountKey,
  });

  if (!refreshed.ok) {
    return { ok: false, code: refreshed.code, error: refreshed.error, accountKey };
  }

  return {
    ok: true,
    auth: { cookie: refreshed.stored.cookie },
    sessionId: refreshed.stored.id,
    source: 'refreshed',
    accountKey,
  };
}

async function probeWorkforce(
  provider: WorkforceProvider,
  auth: WorkforceAuthContext,
): Promise<{ ok: true; associateCount: number } | { ok: false }> {
  try {
    const associates = await provider.fetchDSPAssociates(auth);
    return { ok: true, associateCount: associates.length };
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'WORKFORCE_SESSION_EXPIRED') {
      return { ok: false };
    }
    // Non-auth failure: keep session (avoid login storms on transient Amazon errors).
    console.warn('ensureValidWorkforceSession: probe non-auth error, reusing session', err);
    return { ok: true, associateCount: 0 };
  }
}
