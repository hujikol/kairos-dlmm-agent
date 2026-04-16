/**
 * Centralized TTL cache with named instances for positions, pools, and balances.
 */
class CacheManager {
  #store = new Map();

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