/**
 * Centralized TTL cache with named instances for positions, pools, and balances.
 */
export class CacheManager {
  #store = new Map();
  #evictionTimer = null;

  constructor() {
    // Evict expired entries every 60s — prevents unbounded growth.
    // Use unref() so the timer does NOT keep the Node.js process alive.
    this.#evictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.#store.entries()) {
        if (now > entry.expiresAt) this.#store.delete(key);
      }
    }, 60_000);
    this.#evictionTimer.unref();
  }

  /**
   * Stop the eviction timer. Call this during graceful shutdown
   * or when replacing a cache instance to prevent leaks.
   */
  stop() {
    if (this.#evictionTimer !== null) {
      clearInterval(this.#evictionTimer);
      this.#evictionTimer = null;
    }
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

  // For test injection — bypass TTL check and force-set a value
  setForTesting(key, value) {
    this.#store.set(key, { value, expiresAt: Infinity });
  }

  // For test injection — clear test override
  clearForTesting(key) {
    this.#store.delete(key);
  }
}

export const positionsCache = new CacheManager();
export const poolCache = new CacheManager();
export const balanceCache = new CacheManager();

/**
 * Stop all CacheManager eviction timers.
 * Call this during process shutdown (e.g. SIGTERM, SIGINT) to allow clean exit.
 */
export function stopAll() {
  positionsCache.stop();
  poolCache.stop();
  balanceCache.stop();
}