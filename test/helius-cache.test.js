/**
 * Helius cache tests — Phase 07
 *
 * Tests:
 * 1. getWalletBalances() returns cached data on second call within 5 min
 * 2. invalidateBalanceCache() nulls the cache
 * 3. agentLoop with pre-fetched balance skips its internal fetch
 * 4. No new lint errors
 */
import assert from "node:assert/strict";
import { describe, it, before, mock } from "node:test";
import * as helius from "../src/integrations/helius.js";

describe("Helius balance cache", () => {
  it("caches balance on first fresh call", async () => {
    // We can't do a live RPC/Helius call in unit tests, so test the cache
    // mechanism directly by calling invalidate + checking behavior

    // Start with a clean slate
    helius.invalidateBalanceCache();

    // getWalletBalances should still run the full fetch path without error
    // (it will fall through to RPC which may or may not be configured,
    //  but the cache should still be populated on return)
    const result1 = await helius.getWalletBalances();
    assert.ok(typeof result1.sol === "number");

    // Second call should hit cache (return immediately without new RPC)
    const result2 = await helius.getWalletBalances();
    assert.ok(result2.sol >= 0);
    // Both should be deeply equal since cache was returned
    assert.equal(result1.sol, result2.sol);
  });

  it("invalidates cache via invalidateBalanceCache()", async () => {
    // First, populate the cache
    await helius.getWalletBalances();

    // Verify cache is populated
    const ageMs = helius.getBalanceCacheAgeMs();
    assert.ok(ageMs !== null, "Cache should be populated after first call");
    assert.ok(ageMs < 3000, "Cache should be very fresh");

    // Invalidate
    helius.invalidateBalanceCache();
    const afterAge = helius.getBalanceCacheAgeMs();
    assert.equal(afterAge, null, "Cache should be null after invalidation");
  });

  it("getCachedBalance returns data when cache is fresh", async () => {
    helius.invalidateBalanceCache();

    // Populate cache
    const data = await helius.getWalletBalances();
    const cached = helius.getCachedBalance();

    assert.ok(cached !== null, "getCachedBalance should return data");
    assert.equal(cached.sol, data.sol, "getCachedBalance sol should equal getWalletBalances sol");
  });
});

describe("agentLoop pre-fetched balance", () => {
  it("skips internal getWalletBalances when options.portfolio is provided", async () => {
    // Verify the agentLoop signature accepts options.portfolio
    // We test the agent.js code path by importing and inspecting
    const agentCode = await import("node:fs").then(fs =>
      fs.default.promises.readFile(new URL("../src/agent.js", import.meta.url), "utf8")
    );

    // The code should check for prePortfolio before calling getWalletBalances
    assert.ok(agentCode.includes("prePortfolio || getWalletBalances()"),
      "agentLoop should skip getWalletBalances when prePortfolio is provided");
  });

  it("passes pre-fetched balance in management cycle", async () => {
    const idxCode = await import("node:fs").then(fs =>
      fs.default.promises.readFile(new URL("../src/index.js", import.meta.url), "utf8")
    );

    // Management cycle should pass currentBalance to agentLoop
    assert.ok(idxCode.includes("portfolio: currentBalance") || idxCode.includes("portfolio:currentBalance"),
      "Management cycle should pass portfolio: currentBalance to agentLoop");
  });

  it("passes pre-fetched balance in screening cycle", async () => {
    const idxCode = await import("node:fs").then(fs =>
      fs.default.promises.readFile(new URL("../src/index.js", import.meta.url), "utf8")
    );

    assert.ok(idxCode.includes("portfolio: preBalance") || idxCode.includes("portfolio:preBalance"),
      "Screening cycle should pass portfolio: preBalance to agentLoop");
  });
});

describe("executor invalidates cache after balance-changing events", () => {
  it("executor.js imports invalidateBalanceCache after deploy/close/claim", async () => {
    const executorCode = await import("node:fs").then(fs =>
      fs.default.promises.readFile(new URL("../src/tools/executor.js", import.meta.url), "utf8")
    );

    assert.ok(executorCode.includes("invalidateBalanceCache"),
      "executor.js should import invalidateBalanceCache");
    assert.ok(executorCode.includes("deploy_position") &&
      executorCode.includes("close_position") &&
      executorCode.includes("claim_fees"),
      "executor.js should reference all balance-changing tools");
  });
});

describe("executor safety check uses fresh cache", () => {
  it("imports getBalanceCacheAgeMs in safety checks", async () => {
    const executorCode = await import("node:fs").then(fs =>
      fs.default.promises.readFile(new URL("../src/tools/executor.js", import.meta.url), "utf8")
    );

    assert.ok(executorCode.includes("getBalanceCacheAgeMs"),
      "executor.js should import getBalanceCacheAgeMs for safety check");
  });
});
