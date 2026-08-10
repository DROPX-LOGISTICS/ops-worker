import type { Env, WorkforceAssociate, WorkforceAuthContext } from '../types';
import { workforceBaseUrl, workforceCompanyId, DEFAULT_PORTAL_ACCOUNT } from '../config';
import { WorkforceProvider } from '../providers/WorkforceProvider';
import { createWorkforceSessionStore, createWorkforceAssociateStore } from '../store/factory';
import { ProviderError } from '../errors';
import { ensureValidWorkforceSession } from '../session/ensureWorkforceSession';

export function createWorkforceProvider(env: Env): WorkforceProvider {
  return new WorkforceProvider(workforceBaseUrl(env), workforceCompanyId(env));
}

/**
 * Resolve an active workforce cookie, or null if none stored.
 */
export async function getWorkforceAuth(
  env: Env,
  accountKey = DEFAULT_PORTAL_ACCOUNT,
): Promise<{ auth: WorkforceAuthContext; sessionId: string } | null> {
  const store = createWorkforceSessionStore(env);
  const active = await store.getActive(accountKey);
  if (!active?.cookie) return null;
  return { auth: { cookie: active.cookie }, sessionId: active.id };
}

/**
 * Probe cached session; auto Puppeteer-refresh when expired if credentials + BROWSER exist.
 * Backward-compatible shape used by admin ensure handler.
 */
export async function ensureWorkforceSession(
  env: Env,
  accountKey = DEFAULT_PORTAL_ACCOUNT,
): Promise<
  | { ok: true; associateCount: number; sessionId: string; source: 'cached' | 'refreshed' }
  | {
      ok: false;
      reason: 'NO_SESSION' | 'SESSION_EXPIRED' | 'ERROR' | 'NO_CREDENTIALS' | 'NEEDS_LOCAL_LOGIN';
      message: string;
      code?: string;
      needsLocalLogin?: boolean;
    }
> {
  const result = await ensureValidWorkforceSession(env, {
    accountKey,
    triggeredBy: 'admin-workforce-ensure',
  });

  if (!result.ok) {
    const reason =
      result.code === 'NO_CREDENTIALS'
        ? 'NO_CREDENTIALS'
        : result.code === 'NEEDS_LOCAL_LOGIN'
          ? 'NEEDS_LOCAL_LOGIN'
          : result.code === 'LOGIN_FAILED' ||
              result.code === 'MFA_REQUIRED' ||
              result.code === 'CAPTCHA_REQUIRED' ||
              result.code === 'CAPTURE_TIMEOUT'
            ? 'SESSION_EXPIRED'
            : 'ERROR';
    return {
      ok: false,
      reason,
      message: result.error,
      code: result.code,
      needsLocalLogin: result.needsLocalLogin,
    };
  }

  // If we refreshed without probing associate count, do a quick live count when possible.
  let associateCount = result.associateCount ?? 0;
  if (associateCount === 0) {
    try {
      const provider = createWorkforceProvider(env);
      const associates = await provider.fetchDSPAssociates(result.auth);
      associateCount = associates.length;
    } catch {
      /* count optional */
    }
  }

  return {
    ok: true,
    associateCount,
    sessionId: result.sessionId,
    source: result.source,
  };
}

/**
 * Load transporter_id → associate map for enrichment.
 * Prefer Supabase cache; live-refresh via ensure when forceRefresh or cache empty.
 */
export async function loadWorkforceRosterMap(
  env: Env,
  opts?: { forceRefresh?: boolean; accountKey?: string },
): Promise<{
  byTransporterId: Map<string, WorkforceAssociate>;
  source: 'cache' | 'live' | 'none';
  syncedAt: string | null;
  count: number;
}> {
  const associateStore = createWorkforceAssociateStore(env);
  const accountKey = opts?.accountKey ?? DEFAULT_PORTAL_ACCOUNT;

  const cachedCount = await associateStore.count();
  if (!opts?.forceRefresh && cachedCount > 0) {
    const all = await associateStore.listAll();
    const byTransporterId = new Map(all.map((a) => [a.transporterId, a]));
    return {
      byTransporterId,
      source: 'cache',
      syncedAt: await associateStore.latestSyncedAt(),
      count: all.length,
    };
  }

  const ensured = await ensureValidWorkforceSession(env, {
    accountKey,
    triggeredBy: 'workforce-roster-sync',
    notifyOnFailure: false,
  });

  if (!ensured.ok) {
    if (cachedCount > 0) {
      const all = await associateStore.listAll();
      return {
        byTransporterId: new Map(all.map((a) => [a.transporterId, a])),
        source: 'cache',
        syncedAt: await associateStore.latestSyncedAt(),
        count: all.length,
      };
    }
    return { byTransporterId: new Map(), source: 'none', syncedAt: null, count: 0 };
  }

  const provider = createWorkforceProvider(env);
  const sessionStore = createWorkforceSessionStore(env);
  try {
    // ACTIVE+INACTIVE and OFFBOARDED are separate portal tabs / query params.
    const [activeInactive, offboarded] = await Promise.all([
      provider.fetchDSPAssociates(ensured.auth, {
        operationalStatuses: 'ACTIVE,INACTIVE',
      }),
      provider.fetchDSPAssociates(ensured.auth, {
        operationalStatuses: 'OFFBOARDED',
      }),
    ]);

    const byId = new Map<string, WorkforceAssociate>();
    for (const a of [...activeInactive, ...offboarded]) {
      byId.set(a.transporterId, a);
    }
    const associates = [...byId.values()];

    await associateStore.upsertMany(associates);
    return {
      byTransporterId: byId,
      source: 'live',
      syncedAt: new Date().toISOString(),
      count: associates.length,
    };
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'WORKFORCE_SESSION_EXPIRED') {
      await sessionStore.markExpired(ensured.sessionId);
    }
    if (cachedCount > 0) {
      const all = await associateStore.listAll();
      return {
        byTransporterId: new Map(all.map((a) => [a.transporterId, a])),
        source: 'cache',
        syncedAt: await associateStore.latestSyncedAt(),
        count: all.length,
      };
    }
    console.error('loadWorkforceRosterMap live fetch failed', err);
    return { byTransporterId: new Map(), source: 'none', syncedAt: null, count: 0 };
  }
}
