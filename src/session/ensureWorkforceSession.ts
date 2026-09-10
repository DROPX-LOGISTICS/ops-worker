import type { Env, WorkforceAuthContext } from '../types';
import {
  DEFAULT_PORTAL_ACCOUNT,
  workforceBaseUrl,
  workforceCompanyId,
  workforceProviderId,
} from '../config';
import { createWorkforceSessionStore } from '../store/factory';
import { WorkforceProvider } from '../providers/WorkforceProvider';
import { ProviderError } from '../errors';
import { refreshWorkforceSession } from './refreshWorkforceSession';
import { getWorkforcePortalCredentials, WorkforceLoginStateStore } from './workforceCredentials';

function createProvider(env: Env): WorkforceProvider {
  return new WorkforceProvider(
    workforceBaseUrl(env),
    workforceCompanyId(env),
    workforceProviderId(env),
  );
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

const SHARED_LOGIN_DEADLINE_MS = 120_000;
const SHARED_LOGIN_POLL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared workforce cookie across cash-recon + Report-auto. Concurrent callers
 * reuse it; only Puppeteer login is single-flight. LOGIN_IN_PROGRESS is never
 * shown to product UI — wait silently until the shared session is ready.
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
  const lockStore = new WorkforceLoginStateStore(env);

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
    const adopted = await waitForSharedWorkforceSession(store, provider, lockStore, accountKey, 60_000);
    if (adopted) return adopted;
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

  if (opts.forceRefresh) {
    const refreshed = await refreshWorkforceSession(env, {
      triggeredBy: opts.triggeredBy || 'ensure-workforce-session',
      notifyOnFailure: opts.notifyOnFailure !== false,
      accountKey,
    });
    if (refreshed.ok) {
      return {
        ok: true,
        auth: { cookie: refreshed.stored.cookie },
        sessionId: refreshed.stored.id,
        source: 'refreshed',
        accountKey,
      };
    }
    if (refreshed.code !== 'LOGIN_IN_PROGRESS') {
      return { ok: false, code: refreshed.code, error: refreshed.error, accountKey };
    }
  }

  const deadline = Date.now() + SHARED_LOGIN_DEADLINE_MS;
  let notifyOnFailure = opts.notifyOnFailure !== false;

  while (Date.now() < deadline) {
    const adopted = await tryAdoptWorkforce(store, provider, accountKey);
    if (adopted) return adopted;

    const lockState = await lockStore.getPublic(accountKey);
    if (lockState.loginLocked) {
      await sleep(SHARED_LOGIN_POLL_MS);
      continue;
    }

    const refreshed = await refreshWorkforceSession(env, {
      triggeredBy: opts.triggeredBy || 'ensure-workforce-session',
      notifyOnFailure,
      accountKey,
    });
    notifyOnFailure = false;

    if (refreshed.ok) {
      return {
        ok: true,
        auth: { cookie: refreshed.stored.cookie },
        sessionId: refreshed.stored.id,
        source: 'refreshed',
        accountKey,
      };
    }
    if (refreshed.code === 'LOGIN_IN_PROGRESS') {
      await sleep(SHARED_LOGIN_POLL_MS);
      continue;
    }
    return { ok: false, code: refreshed.code, error: refreshed.error, accountKey };
  }

  const last = await tryAdoptWorkforce(store, provider, accountKey);
  if (last) return last;

  return {
    ok: false,
    code: 'SESSION_UNAVAILABLE',
    accountKey,
    error: 'Workforce session is not ready yet. Please try again in a moment.',
  };
}

async function tryAdoptWorkforce(
  store: ReturnType<typeof createWorkforceSessionStore>,
  provider: WorkforceProvider,
  accountKey: string,
): Promise<EnsureWorkforceSessionResult | null> {
  const active = await store.getActive(accountKey);
  if (!active?.cookie) return null;
  const auth = { cookie: active.cookie };
  const probe = await probeWorkforce(provider, auth);
  if (!probe.ok) return null;
  return {
    ok: true,
    auth,
    sessionId: active.id,
    source: 'cached',
    accountKey,
    associateCount: probe.associateCount,
  };
}

async function waitForSharedWorkforceSession(
  store: ReturnType<typeof createWorkforceSessionStore>,
  provider: WorkforceProvider,
  lockStore: WorkforceLoginStateStore,
  accountKey: string,
  maxWaitMs: number,
): Promise<EnsureWorkforceSessionResult | null> {
  if (maxWaitMs <= 0) return null;
  const deadline = Date.now() + maxWaitMs;
  let first = true;
  while (Date.now() < deadline) {
    if (!first) await sleep(SHARED_LOGIN_POLL_MS);
    first = false;
    const adopted = await tryAdoptWorkforce(store, provider, accountKey);
    if (adopted) {
      console.log(`ensureValidWorkforceSession: adopted shared session for ${accountKey}`);
      return adopted;
    }
    const lockState = await lockStore.getPublic(accountKey);
    if (!lockState.loginLocked) {
      return tryAdoptWorkforce(store, provider, accountKey);
    }
  }
  return null;
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
    console.warn('ensureValidWorkforceSession: probe non-auth error, reusing session', err);
    return { ok: true, associateCount: 0 };
  }
}
