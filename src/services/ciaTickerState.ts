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

const CACHE_KEY = 'cia:ticker:state';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
