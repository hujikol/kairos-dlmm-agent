/**
 * Unified tool-result cache with TTL support.
 * Reduces redundant LLM tool calls and API pings.
 */

const CACHE = new Map();
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

/**
 * Get cached tool result or compute + cache it.
 * @param {string} name - tool name
 * @param {string} key - cache key (usually address or id)
 * @param {Function} fn - async function to compute value
 * @param {number} [ttlOverride] - TTL in seconds
 */
export async function cachedTool(name, key, fn, ttlOverride) {
  const cacheKey = `${name}:${key}`;
  const entry = CACHE.get(cacheKey);
  if (entry && entry.exp > Date.now()) return entry.value;

  const value = await fn();
  CACHE.set(cacheKey, { value, exp: Date.now() + (ttlOverride ?? TTL_MAP[name] ?? 120) * 1000 });
  return value;
}

/**
 * Invalidate a specific cache entry.
 */
export function invalidateCache(name, key) {
  CACHE.delete(`${name}:${key}`);
}

/**
 * Clear all cache entries.
 */
export function clearCache() {
  CACHE.clear();
}

// Evict expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE) if (v.exp < now) CACHE.delete(k);
}, 60_000);
