/**
 * Tests for holder-security recheck helpers:
 * - isTokenSafeFresh (cache-bypassing recheck for open positions)
 * - shouldCloseOnSecurityRecheck (management-level close decision)
 * Run with: node --test test/test-security-recheck.js
 */

import { it, beforeEach, afterEach } from "node:test";
import Database from "better-sqlite3";
import { _injectDB } from "../src/core/db.js";
import {
  isTokenSafe,
  isTokenSafeFresh,
  shouldCloseOnSecurityRecheck,
  clearTokenSecurityCache,
  _injectHolders,
} from "../src/features/token-security.js";

let _testDb;

beforeEach(() => {
  _testDb = new Database(":memory:");
  _injectDB(_testDb);
  clearTokenSecurityCache();
  _injectHolders(null);
});

afterEach(() => {
  _injectHolders(null);
  if (_testDb) {
    try { _testDb.close(); } catch { /* ignore */ }
  }
});

function makeHolders(pctList) {
  return pctList.map((pct, i) => ({
    address: `holder${i}`,
    amount: pct * 1000,
    pct,
    is_pool: false,
  }));
}

await it("isTokenSafeFresh bypasses cache and refetches holders", async () => {
  let callCount = 0;
  _injectHolders(() => {
    callCount++;
    return {
      mint: "FreshToken",
      holders: makeHolders([30, 25, 20, 15, 10]),
      bundle_pct: null,
      dev_sold_all: false,
    };
  });

  await isTokenSafe("FreshToken"); // seeds the 5m cache
  if (callCount !== 1) throw new Error(`Expected 1 holder call after isTokenSafe, got ${callCount}`);

  const fresh = await isTokenSafeFresh("FreshToken"); // must bypass cache
  if (callCount !== 2) throw new Error(`Expected 2 holder calls after isTokenSafeFresh (cache bypassed), got ${callCount}`);
  if (fresh?.safe !== true) throw new Error(`Expected safe=true, got ${JSON.stringify(fresh)}`);
});

await it("isTokenSafeFresh returns unsafe decision for concentrated holders", async () => {
  _injectHolders(() => ({
    mint: "RugToken",
    holders: makeHolders([60, 22, 13, 3, 2]),
    bundle_pct: null,
    dev_sold_all: false,
  }));

  const result = await isTokenSafeFresh("RugToken");
  if (result?.safe !== false) throw new Error(`Expected safe=false, got ${JSON.stringify(result)}`);
  if (!result.reason?.includes("top 3 holders")) throw new Error(`Unexpected reason: ${result.reason}`);
});

await it("shouldCloseOnSecurityRecheck truth table", () => {
  if (shouldCloseOnSecurityRecheck({ safe: false }) !== true) throw new Error("{safe:false} must close");
  if (shouldCloseOnSecurityRecheck({ safe: true }) !== false) throw new Error("{safe:true} must not close");
  if (shouldCloseOnSecurityRecheck(null) !== false) throw new Error("null must not close");
  if (shouldCloseOnSecurityRecheck({ safe: false, reason: "top 3 holders control 95.0% of supply (>90% threshold)" }) !== true) {
    throw new Error("{safe:false,reason} must close");
  }
  // Availability is not unsafety at management level — API errors/unavailable must not close
  if (shouldCloseOnSecurityRecheck({ safe: false, reason: "holder security data unavailable" }) !== false) {
    throw new Error("unavailable holder data must not close");
  }
});
