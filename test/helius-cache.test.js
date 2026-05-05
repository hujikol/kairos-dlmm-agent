/**
 * Helius cache tests.
 *
 * Behavioral tests:
 * 1. getWalletBalances() returns cached data on second call within TTL
 * 2. invalidateBalanceCache() nulls the cache
 * 3. getBalanceCacheAgeMs() returns null when cache is empty
 * 4. getCachedBalance() returns null when cache is empty
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as helius from "../src/integrations/helius.js";
import { balanceCache } from "../src/core/cache-manager.js";

describe("Helius balance cache", () => {
  it("caches balance on first fresh call", async () => {
    helius.invalidateBalanceCache();
    const result1 = await helius.getWalletBalances();
    assert.ok(typeof result1.sol === "number");
    // Second call should return same data (from cache)
    const result2 = await helius.getWalletBalances();
    assert.equal(result1.sol, result2.sol);
  });

  it("getBalanceCacheAgeMs() returns null when cache is empty", () => {
    helius.invalidateBalanceCache();
    assert.equal(helius.getBalanceCacheAgeMs(), null);
  });

  it("getBalanceCacheAgeMs() returns number when cache is populated", async () => {
    helius.invalidateBalanceCache();
    await helius.getWalletBalances();
    const age = helius.getBalanceCacheAgeMs();
    assert.ok(age !== null);
    assert.ok(age >= 0);
    assert.ok(age < 5000); // should be very fresh
  });

  it("invalidateBalanceCache() clears the cache", async () => {
    await helius.getWalletBalances();
    helius.invalidateBalanceCache();
    assert.equal(helius.getBalanceCacheAgeMs(), null);
    assert.equal(helius.getCachedBalance(), null);
  });

  it("getCachedBalance() returns null when cache is empty", () => {
    helius.invalidateBalanceCache();
    assert.equal(helius.getCachedBalance(), null);
  });

  it("getCachedBalance() returns data when cache is fresh", async () => {
    helius.invalidateBalanceCache();
    const data = await helius.getWalletBalances();
    const cached = helius.getCachedBalance();
    assert.ok(cached !== null);
    assert.equal(cached.sol, data.sol);
  });

  after(() => {
    helius.invalidateBalanceCache();
    balanceCache.stop();
    process.exit(0); // force exit — CacheManager eviction timer keeps event loop alive
  });
});
