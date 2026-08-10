/**
 * Two-tier TTL cache for read-heavy API responses.
 *
 * L1 — module-scope Map (per Worker isolate): absorbs bursts + request coalescing.
 * L2 — optional Supabase `api_response_cache`: shared across isolates/colos so
 *      many concurrent dashboard users within ~60s share one Amazon compute.
 */

import type { ApiResponseCacheStore } from '../store/ApiResponseCacheStore';

interface Entry {
  promise: Promise<unknown>;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

function evictIfNeeded(now: number): void {
  if (store.size < MAX_ENTRIES) return;
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
}

/**
 * Return cached value for `key` if fresh, otherwise run `compute` once and
 * cache the result for `ttlMs`. Failed computes are evicted immediately so
 * errors are never cached.
 *
 * Pass `shared` to also read/write Supabase so other isolates hit the same
 * response within the TTL window.
 */
export async function cachedJson<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  shared?: ApiResponseCacheStore,
): Promise<{ value: T; cacheHit: boolean }> {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) {
    try {
      return { value: (await existing.promise) as T, cacheHit: true };
    } catch {
      store.delete(key);
    }
  }

  // L2 shared hit — seed L1 and return without Amazon.
  if (shared) {
    try {
      const sharedHit = await shared.get<T>(key);
      if (sharedHit !== null && sharedHit !== undefined) {
        const promise = Promise.resolve(sharedHit);
        store.set(key, { promise, expiresAt: now + ttlMs });
        return { value: sharedHit, cacheHit: true };
      }
    } catch (err) {
      console.error('shared cache get failed', err);
    }
  }

  evictIfNeeded(now);
  const promise = compute().then(async (value) => {
    if (shared) {
      try {
        await shared.set(key, value, ttlMs);
      } catch (err) {
        console.error('shared cache set failed', err);
      }
    }
    return value;
  });
  store.set(key, { promise, expiresAt: now + ttlMs });

  try {
    return { value: await promise, cacheHit: false };
  } catch (err) {
    store.delete(key);
    throw err;
  }
}

/** Drop matching L1 keys (e.g. after a manual refresh writes new snapshots). */
export function invalidateCache(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Drop L1 + L2 keys matching prefix. */
export async function invalidateCacheAll(
  prefix: string,
  shared?: ApiResponseCacheStore,
): Promise<void> {
  invalidateCache(prefix);
  if (shared) await shared.deletePrefix(prefix);
}
