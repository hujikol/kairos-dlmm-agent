/**
 * Unit tests for token-security.js
 * Run with: node --test test/test-token-security.js
 */

import { fileURLToPath } from "url";
import path from "path";
import { it, beforeEach, afterEach } from "node:test";
import Database from "better-sqlite3";
import { _injectDB } from "../src/core/db.js";
import {
  clearTokenSecurityCache,
  _injectHolders,
} from "../src/features/token-security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _testDb;

beforeEach(() => {
  _testDb = new Database(":memory:");
  _injectDB(_testDb);
  clearTokenSecurityCache();
  _injectHolders(null); // reset
});

afterEach(() => {
  _injectHolders(null);
  if (_testDb) {
    try { _testDb.close(); } catch { /* ignore */ }
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHolders(pctList, isPool = false) {
  return pctList.map((pct, i) => ({
    address: `holder${i}`,
    amount: parseFloat((pct * 1000).toFixed(4)),
    pct: parseFloat(pct.toFixed(4)),
    is_pool: isPool,
  }));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

await it("isTokenSafe returns safe for normal token with healthy holder distribution", async () => {
  const { isTokenSafe } = await import("../src/features/token-security.js");

  // Inject mock holder data: top 3 = 20+15+12 = 47% (< 90% threshold)
  _injectHolders(() => ({
    mint: "SafeToken",
    holders: makeHolders([20, 15, 12, 10, 8, 7, 6, 5, 4, 3]),
    bundle_pct: 30,
    dev_sold_all: false,
  }));

  const result = await isTokenSafe("SafeToken");
  if (result.safe !== true) throw new Error(`Expected safe=true, got ${JSON.stringify(result)}`);
});

await it("isTokenSafe returns unsafe when top 3 holders exceed 90%", async () => {
  const { isTokenSafe } = await import("../src/features/token-security.js");

  // Inject mock — top 3 = 60+22+13 = 95% — exceeds threshold
  _injectHolders(() => ({
    mint: "ToxicToken",
    holders: makeHolders([60, 22, 13, 3, 2]),
    bundle_pct: null,
    dev_sold_all: false,
  }));

  const result = await isTokenSafe("ToxicToken");
  if (result.safe !== false) throw new Error(`Expected safe=false, got ${JSON.stringify(result)}`);
  if (!result.reason?.includes("top 3 holders")) {
    throw new Error(`Expected holder concentration reason, got: ${result.reason}`);
  }
});

await it("isTokenSafe returns unsafe for blacklisted token", async () => {
  const { addToBlacklist } = await import("../src/features/token-blacklist.js");
  addToBlacklist({ mint: "BlacklistedToken123", symbol: "BAD", reason: "test rugged" });

  const { isTokenSafe } = await import("../src/features/token-security.js");
  const result = await isTokenSafe("BlacklistedToken123");

  if (result.safe !== false) throw new Error(`Expected safe=false for blacklisted token, got ${JSON.stringify(result)}`);
  if (!result.reason?.includes("blacklisted")) {
    throw new Error(`Expected blacklisted reason, got: ${result.reason}`);
  }
});

await it("cache returns same result on second call without re-fetching holders", async () => {
  const { isTokenSafe } = await import("../src/features/token-security.js");
  clearTokenSecurityCache();

  let callCount = 0;
  _injectHolders(() => {
    callCount++;
    return {
      mint: "CachedToken",
      holders: makeHolders([30, 25, 20, 15, 10]),
      bundle_pct: null,
      dev_sold_all: false,
    };
  });

  await isTokenSafe("CachedToken");
  await isTokenSafe("CachedToken"); // second call — should hit cache

  if (callCount !== 1) throw new Error(`Expected 1 holder call (cache hit on 2nd), got ${callCount}`);
});