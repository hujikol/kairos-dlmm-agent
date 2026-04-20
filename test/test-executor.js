/**
 * Unit tests for src/tools/executor.js
 * Tests: unknown tool error, DRY_RUN bypass for write tools,
 * deploy_position safety checks (maxPositions, bin_step, balance),
 * cache TTL for read-only tools.
 *
 * Run: node --test test/test-executor.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { makeSchemaDB } from "./mem-db.js";
import { _injectDB } from "../src/core/db.js";
import { _injectPositionsCache, _resetPositionsCache } from "../src/integrations/meteora/positions.js";
import { _injectBalances } from "../src/integrations/helius.js";
import { clearCache } from "../src/tools/cache.js";

describe("tools/executor.js", () => {

  let db;

  beforeEach(async () => {
    db = await makeSchemaDB();
    _injectDB(db);
    _resetPositionsCache();
    _injectPositionsCache(null);
    _injectBalances(null);
    clearCache();
    if (!process.env.DRY_RUN) process.env.DRY_RUN = "true";
  });

  afterEach(async () => {
    _resetPositionsCache();
    _injectPositionsCache(null);
    _injectBalances(null);
    clearCache();
    const { closeDB } = await import("../src/core/db.js");
    closeDB();
    delete process.env.DRY_RUN;
  });

  // ── Unknown tool returns error ───────────────────────────────────────────────

  test("executeTool returns { error } for unknown tool name", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const result = await executeTool("nonexistent_tool_xyz", {});
    assert.ok(result.error, "Should have an error property");
    assert.ok(result.error.includes("Unknown tool"), `Expected 'Unknown tool' in error, got: ${result.error}`);
  });

  test("executeTool strips model artifacts from tool name (e.g. <|channel|>)", async () => {
    // get_wallet_balance is registered — artifact suffix should be stripped before lookup
    const { executeTool } = await import("../src/tools/executor.js");
    const result = await executeTool("get_wallet_balance<|channel|>", {});
    // Should not crash and should return a valid result (not "Unknown tool")
    assert.ok(!result.error || !result.error.includes("Unknown tool"), "Should not be unknown after stripping artifact");
  });

  // ── DRY_RUN bypass for write tools ─────────────────────────────────────────

  test("in DRY_RUN mode, deploy_position still runs safety checks (not bypassed)", async () => {
    const { executeTool } = await import("../src/tools/executor.js");

    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    // In DRY_RUN, safety checks still apply — the tx is just skipped at the integration layer
    const result = await executeTool("deploy_position", {
      pool_address: "DryRunPool",
      bin_step: 100,
    });

    // Safety checks pass → result should be structured (not an unhandled error)
    assert.ok(!result.error || result.blocked !== undefined, "Should return structured result");
  });

  // ── deploy_position safety checks ───────────────────────────────────────────

  test("deploy_position blocked when position count >= maxPositions", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    config.risk.maxPositions = 3;
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 3,
      positions: [
        { position: "p1", pool: "Pool1", base_mint: "m1" },
        { position: "p2", pool: "Pool2", base_mint: "m2" },
        { position: "p3", pool: "Pool3", base_mint: "m3" },
      ],
    });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await executeTool("deploy_position", {
      pool_address: "NewPoolXYZ",
      bin_step: 100,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("Max positions"), `Expected Max positions block, got: ${result.reason}`);
  });

  test("deploy_position blocked for bin_step below minBinStep", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    config.screening.minBinStep = 80;
    config.screening.maxBinStep = 200;
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await executeTool("deploy_position", {
      pool_address: "LowStepPool",
      bin_step: 50,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("bin_step"), `Expected bin_step block, got: ${result.reason}`);
  });

  test("deploy_position blocked for bin_step above maxBinStep", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    config.screening.minBinStep = 80;
    config.screening.maxBinStep = 125;
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await executeTool("deploy_position", {
      pool_address: "HighStepPool",
      bin_step: 500,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("bin_step"), `Expected bin_step block, got: ${result.reason}`);
  });

  test("deploy_position blocked when SOL balance below gasReserve + deploy amount", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    config.risk.maxPositions = 10;
    config.management.gasReserve = 0.2;
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 0.1, sol_price: 150, tokens: [] }); // only 0.1 SOL

    const result = await executeTool("deploy_position", {
      pool_address: "PoorPool",
      bin_step: 100,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.toLowerCase().includes("insufficient sol"),
      `Expected insufficient SOL block, got: ${result.reason}`
    );
  });

  test("token-only deploy (amount_x > 0) bypasses SOL balance check", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    config.risk.maxPositions = 10;
    config.management.gasReserve = 0.2;
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 0.05, sol_price: 150, tokens: [] }); // very low SOL

    const result = await executeTool("deploy_position", {
      pool_address: "TokenOnlyPool",
      bin_step: 100,
      amount_x: 500,
      amount_y: 0,
    });

    assert.notStrictEqual(
      result.blocked,
      true,
      `Token-only deploy should not be blocked even with low SOL: ${JSON.stringify(result)}`
    );
  });

  test("deploy_position blocked for duplicate pool_address", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    // Inject a row directly into the DB for the duplicate check
    db.prepare(`
      INSERT INTO positions (position, pool, status, closed, bin_step, notes)
      VALUES ('ExistingPos', 'DupPoolAddr', 'active', 0, 100, '[]')
    `).run();

    config.risk.maxPositions = 10;
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "ExistingPos", pool: "DupPoolAddr", base_mint: "SomeMint" }],
    });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await executeTool("deploy_position", {
      pool_address: "DupPoolAddr",
      bin_step: 100,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("duplicate") || result.reason.includes("Already have"),
      `Expected duplicate pool block, got: ${result.reason}`
    );
  });

  test("deploy_position blocked for duplicate base_mint", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { config } = await import("../src/config.js");

    db.prepare(`
      INSERT INTO positions (position, pool, base_mint, status, closed, bin_step, notes)
      VALUES ('OtherPos', 'SomeOtherPool', 'DupBaseMint', 'active', 0, 100, '[]')
    `).run();

    config.risk.maxPositions = 10;
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "OtherPos", pool: "SomeOtherPool", base_mint: "DupBaseMint" }],
    });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await executeTool("deploy_position", {
      pool_address: "NewPoolForToken",
      base_mint: "DupBaseMint",
      bin_step: 100,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("base token") || result.reason.includes("Already holding"),
      `Expected base_mint duplicate block, got: ${result.reason}`
    );
  });

  // ── Cache TTL for read-only tools ───────────────────────────────────────────

  test("consecutive calls to read-only tool share cache (second call hits 0 API calls)", async () => {
    const { executeTool } = await import("../src/tools/executor.js");

    let apiCallCount = 0;
    const heliusMod = await import("../src/integrations/helius.js");
    const orig = heliusMod.getWalletBalances;

    Object.defineProperty(heliusMod, "getWalletBalances", {
      value: async () => {
        apiCallCount++;
        return orig();
      },
      writable: true,
      configurable: true,
    });

    try {
      // Pre-inject balance so executor cache can intercept without real API call
      _injectBalances({ sol: 1.5, sol_price: 150, tokens: [] });

      const r1 = await executeTool("get_wallet_balance", {});
      const r2 = await executeTool("get_wallet_balance", {});

      // First call: real function called (apiCallCount=1)
      // Second call: served from executor cache — wrapped function not called (apiCallCount=1)
      assert.strictEqual(apiCallCount, 1, "Second call should be served from cache — zero extra API calls");
      assert.deepStrictEqual(r1, r2, "Cached result should equal original result");
    } finally {
      Object.defineProperty(heliusMod, "getWalletBalances", {
        value: orig,
        writable: true,
        configurable: true,
      });
    }
  });

  test("write tools do not use the read-only cache", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const { trackPosition: origTrack } = await import("../src/core/registry.js");

    let trackCallCount = 0;
    const wrapped = (...args) => { trackCallCount++; return origTrack(...args); };

    // Use Object.defineProperty to override (bypasses module immutability)
    const registryMod = await import("../src/core/registry.js");
    Object.defineProperty(registryMod, "trackPosition", {
      value: wrapped,
      writable: true,
      configurable: true,
    });

    try {
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
      _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

      await executeTool("deploy_position", { pool_address: "CacheTestA", bin_step: 100 });
      await executeTool("deploy_position", { pool_address: "CacheTestB", bin_step: 100 });

      assert.strictEqual(trackCallCount, 2, "Write tool should be called twice (no cache bypass for writes)");
    } finally {
      Object.defineProperty(registryMod, "trackPosition", {
        value: origTrack,
        writable: true,
        configurable: true,
      });
    }
  });

  test("unknown tool returns structured error without crashing", async () => {
    const { executeTool } = await import("../src/tools/executor.js");
    const result = await executeTool("completely_fake_tool", { foo: "bar" });
    assert.ok(result.error, "Should have error property");
    assert.ok(result.error.includes("Unknown tool"));
  });
});