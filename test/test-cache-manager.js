import test from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../src/core/cache-manager.js";

test("CacheManager evicts the oldest entry at its configured capacity", () => {
  const cache = new CacheManager({ maxEntries: 2 });
  cache.set("first", 1, 60_000);
  cache.set("second", 2, 60_000);
  cache.set("third", 3, 60_000);

  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("second"), 2);
  assert.equal(cache.get("third"), 3);
});

test("CacheManager sweeps entries after their TTL without a read", () => {
  const cache = new CacheManager();
  cache.set("expired", 1, -1);

  assert.equal(cache.sweepExpired(), 1);
  assert.equal(cache.get("expired"), undefined);
});