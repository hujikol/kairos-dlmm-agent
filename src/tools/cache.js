/**
 * Unified tool-result cache with TTL support.
 * Reduces redundant LLM tool calls and API pings.
 *
 * Uses pending-promise deduplication: concurrent calls with the same cache key
 * share a single in-flight computation rather than each triggering their own fetch.
 */

const CACHE = new Map(); // cacheKey → { exp, value }
const PENDING = new Map(); // cacheKey → pending Promise

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

// Named exports for test injection
export { CACHE, PENDING, TTL_MAP };

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

  // Return cached value if fresh
  const entry = CACHE.get(cacheKey);
  if (entry && entry.exp > now) return entry.value;

  // Return pending promise if another call is already computing this key
  const pending = PENDING.get(cacheKey);
  if (pending) return pending;

  // Compute and cache
  const promise = fn().then((value) => {
    CACHE.set(cacheKey, { value, exp: now + (ttlOverride ?? TTL_MAP[name] ?? 120) * 1000 });
    PENDING.delete(cacheKey);
    return value;
  }).catch((err) => {
    PENDING.delete(cacheKey);
    throw err;
  });

  PENDING.set(cacheKey, promise);
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
  for (const p of PENDING.values()) {
    if (typeof p.cancel === "function") p.cancel();
  }
  PENDING.clear();
}

// Evict expired entries every 60s
const _evictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE) if (v.exp < now) CACHE.delete(k);
}, 60_000);

// Allow callers to stop the eviction timer (e.g., during shutdown)
export function stopCacheEviction() {
  clearInterval(_evictionTimer);
}
