/**
 * Unified tool-result cache with TTL support.
 * Reduces redundant LLM tool calls and API pings.
 *
 * Uses pending-promise deduplication: concurrent calls with the same cache key
 * share a single in-flight computation rather than each triggering their own fetch.
 */

import { log } from "../core/logger.js";

const CACHE = new Map(); // cacheKey → { exp, value }
const PENDING = new Map(); // cacheKey → { promise, createdAt }

const MAX_PENDING_SIZE = 200;
const PENDING_TTL_MS = 30_000;

const TTL_MAP = {
  get_candidates:     5 * 60,
  pool_detail:        3 * 60,
  active_bin:         1 * 60,
  token_info:        10 * 60,
  token_holders:     10 * 60,
  get_position_pnl:   2 * 60,
  get_my_positions:   5 * 60,
  get_balances:       5 * 60,
  discover_pools:     5 * 60,
  search_pools:       3 * 60,
  get_wallet_balance: 5 * 60,
};

const MAX_CACHE_SIZE = 100;

/**
 * Prune stale PENDING entries (promises older than PENDING_TTL_MS that didn't settle).
 * Called on every cachedTool invocation to prevent unbounded growth.
 */
function prunePending() {
  const now = Date.now();
  for (const [k, v] of PENDING) {
    if (now - v.createdAt > PENDING_TTL_MS) PENDING.delete(k);
  }
  if (PENDING.size > MAX_PENDING_SIZE) {
    const oldest = PENDING.keys().next().value;
    if (oldest) PENDING.delete(oldest);
  }
}

/**
 * Get cached tool result or compute + cache it.
 * @param {string} name - tool name
 * @param {string} key - cache key (usually address or id)
 * @param {Function} fn - async function to compute value
 * @param {number} [ttlOverride] - TTL in seconds
 */
export async function cachedTool(name, key, fn, ttlOverride) {
  const cacheKey = `${name}:${key}`;
  const now = Date.now();

  prunePending();

  // Return cached value if fresh
  const entry = CACHE.get(cacheKey);
  if (entry && entry.exp > now) return entry.value;

  // Return pending promise if another call is already computing this key
  const pending = PENDING.get(cacheKey);
  if (pending) return pending.promise;

  // Compute and cache
  const promise = fn().then((value) => {
    if (CACHE.size >= MAX_CACHE_SIZE) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(cacheKey, { value, exp: now + (ttlOverride ?? TTL_MAP[name] ?? 120) * 1000 });
    PENDING.delete(cacheKey);
    return value;
  }).catch((err) => {
    PENDING.delete(cacheKey);
    throw err;
  });

  PENDING.set(cacheKey, { promise, createdAt: now });
  return promise;
}

/**
 * Invalidate a specific cache entry.
 */
export function invalidateCache(name, key) {
  CACHE.delete(`${name}:${key}`);
  PENDING.delete(`${name}:${key}`);
}

/**
 * Clear all cache entries and cancel pending computations.
 */
export function clearCache() {
  CACHE.clear();
  PENDING.clear();
}

// Evict expired entries every 60s — unref so it doesn't keep process alive
const _evictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE) if (v.exp < now) CACHE.delete(k);
  prunePending();
  if (CACHE.size > 50) log("warn", "cache", `CACHE size is ${CACHE.size}`);
}, 60_000);
_evictionTimer.unref();

// Allow callers to stop the eviction timer (e.g., during shutdown)
export function stopCacheEviction() {
  clearInterval(_evictionTimer);
}
