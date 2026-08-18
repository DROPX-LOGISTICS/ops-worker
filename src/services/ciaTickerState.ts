import type { Env } from '../types';
import { createApiResponseCacheStore } from '../store/factory';

export type CiaTickerOutcome = 'processed' | 'skipped' | 'idle' | 'failed';

export interface CiaTickerState {
  lastTickAt: string;
  lastStationCode: string | null;
  lastRunId: string | null;
  outcome: CiaTickerOutcome;
  skipReason: string | null;
  done: boolean;
}

export interface CiaFrontendLeaseState {
  runId: string | null;
  touchedAt: string;
}

const CACHE_KEY = 'cia:ticker:state';
const FRONTEND_LEASE_KEY = 'cia:frontend:lease';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CIA_FRONTEND_LEASE_MS = 45 * 1000;

export async function readCiaTickerState(env: Env): Promise<CiaTickerState | null> {
  const store = createApiResponseCacheStore(env);
  const raw = await store.get<CiaTickerState>(CACHE_KEY);
  if (!raw?.lastTickAt) return null;
  return raw;
}

export async function writeCiaTickerState(
  env: Env,
  patch: Partial<CiaTickerState> & { outcome: CiaTickerOutcome },
): Promise<void> {
  const store = createApiResponseCacheStore(env);
  const prev = (await store.get<CiaTickerState>(CACHE_KEY)) ?? null;
  const next: CiaTickerState = {
    lastTickAt: new Date().toISOString(),
    lastStationCode: patch.lastStationCode ?? prev?.lastStationCode ?? null,
    lastRunId: patch.lastRunId ?? prev?.lastRunId ?? null,
    outcome: patch.outcome,
    skipReason: patch.skipReason ?? null,
    done: Boolean(patch.done),
  };
  await store.set(CACHE_KEY, next, CACHE_TTL_MS);
}

export async function readCiaFrontendLease(env: Env): Promise<CiaFrontendLeaseState | null> {
  const store = createApiResponseCacheStore(env);
  const raw = await store.get<CiaFrontendLeaseState>(FRONTEND_LEASE_KEY);
  if (!raw?.touchedAt) return null;
  return raw;
}

export async function touchCiaFrontendLease(env: Env, runId?: string | null): Promise<CiaFrontendLeaseState> {
  const store = createApiResponseCacheStore(env);
  const next: CiaFrontendLeaseState = {
    runId: runId?.trim() ? runId.trim() : null,
    touchedAt: new Date().toISOString(),
  };
  await store.set(FRONTEND_LEASE_KEY, next, CACHE_TTL_MS);
  return next;
}

export function isCiaFrontendLeaseActive(
  lease: CiaFrontendLeaseState | null,
  args?: { runId?: string | null; nowMs?: number },
): boolean {
  if (!lease?.touchedAt) return false;
  if (args?.runId && lease.runId && lease.runId !== args.runId) return false;
  const touchedMs = Date.parse(lease.touchedAt);
  if (!Number.isFinite(touchedMs)) return false;
  return (args?.nowMs ?? Date.now()) - touchedMs < CIA_FRONTEND_LEASE_MS;
}
