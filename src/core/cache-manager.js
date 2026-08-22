/**
 * Centralized bounded TTL cache with named instances for positions, pools, and balances.
 */
const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const _instances = new Set();

export class CacheManager {
  #store = new Map();
  #maxEntries;

  constructor({ maxEntries = 500 } = {}) {
    this.#maxEntries = maxEntries;
    _instances.add(this);
  }

  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  getWithMetadata(key) {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key, value, ttlMs) {
    if (!this.#store.has(key) && this.#store.size >= this.#maxEntries) {
      this.#store.delete(this.#store.keys().next().value);
    }
    this.#store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  delete(key) {
    this.#store.delete(key);
  }

  clear() {
    this.#store.clear();
  }

  sweepExpired(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.#store) {
      if (entry.expiresAt < now) {
        this.#store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // For test injection — bypass TTL check and force-set a value
  setForTesting(key, value) {
    this.#store.set(key, { value, expiresAt: Infinity });
  }

  // For test injection — clear test override
  clearForTesting(key) {
    this.#store.delete(key);
  }
}

export function sweepAllCaches(now = Date.now()) {
  let removed = 0;
  for (const cache of _instances) removed += cache.sweepExpired(now);
  return removed;
}

const _sweepTimer = setInterval(sweepAllCaches, CACHE_SWEEP_INTERVAL_MS);
_sweepTimer.unref?.();

export const positionsCache = new CacheManager();
export const poolCache = new CacheManager();
export const balanceCache = new CacheManager();
