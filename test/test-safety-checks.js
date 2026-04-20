/**
 * Integration tests for runSafetyChecks in src/tools/executor.js.
 * Uses _injectPositionsCache, _injectBalances, and direct config mutation.
 * Covers: bin_step validation, position count, duplicate pool,
 *         duplicate base_mint, SOL balance, token-only bypass.
 *
 * Run: node --test test/test-safety-checks.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import Database from "better-sqlite3";
import { _injectDB } from "../src/core/db.js";
import { _injectPositionsCache, _resetPositionsCache } from "../src/integrations/meteora/positions.js";
import { _injectBalances } from "../src/integrations/helius.js";

function freshDB() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = OFF");
  return db;
}

describe("runSafetyChecks — deploy_position", () => {

  let db;

  beforeEach(() => {
    db = freshDB();
    _injectDB(db);
    _injectPositionsCache(null);
    _injectBalances(null);
    _resetPositionsCache();
    if (!process.env.DRY_RUN) process.env.DRY_RUN = "true";
  });

  afterEach(async () => {
    _injectPositionsCache(null);
    _injectBalances(null);
    _resetPositionsCache();
    const { closeDB } = await import("../src/core/db.js");
    closeDB();
    delete process.env.DRY_RUN;
  });

  // ── Helper: call executeTool with deploy_position ──────────────────
  async function tryDeploy(args) {
    const { executeTool } = await import("../src/tools/executor.js");
    return executeTool("deploy_position", args);
  }

  // ── bin_step out of range ───────────────────────────────────────────
  test("blocks deploy when bin_step below minimum", async () => {
    const { config } = await import("../src/config.js");
    const origMin = config.screening.minBinStep;
    config.screening.minBinStep = 0.001;

    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5.0, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolMin", bin_step: 0.0001 });

    config.screening.minBinStep = origMin;
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("bin_step"), `Got: ${result.reason}`);
  });

  test("blocks deploy when bin_step above maximum", async () => {
    const { config } = await import("../src/config.js");
    const origMax = config.screening.maxBinStep;
    config.screening.maxBinStep = 1.0;

    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5.0, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolMax", bin_step: 99.0 });

    config.screening.maxBinStep = origMax;
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("bin_step"), `Got: ${result.reason}`);
  });

  // ── position count at max ───────────────────────────────────────────
  test("blocks deploy when at max positions", async () => {
    const { config } = await import("../src/config.js");
    const origMax = config.risk.maxPositions;
    config.risk.maxPositions = 3;

    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 3,
      positions: [
        { position: "p1", pool: "Pool1", base_mint: "M1" },
        { position: "p2", pool: "Pool2", base_mint: "M2" },
        { position: "p3", pool: "Pool3", base_mint: "M3" },
      ],
    });
    _injectBalances({ sol: 5.0, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolNew", bin_step: 0.01 });

    config.risk.maxPositions = origMax;
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("Max positions"), `Got: ${result.reason}`);
  });

  // ── duplicate pool ─────────────────────────────────────────────────
  test("blocks deploy when pool already has a position", async () => {
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "pos1", pool: "DupPool", base_mint: "MintX" }],
    });
    _injectBalances({ sol: 5.0, tokens: [] });

    const result = await tryDeploy({ pool_address: "DupPool", bin_step: 0.01 });

    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("Already have") || result.reason.includes("duplicate"),
      `Got: ${result.reason}`
    );
  });

  // ── duplicate base_mint ────────────────────────────────────────────
  test("blocks deploy when base_mint already held in another pool", async () => {
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "pos1", pool: "PoolOne", base_mint: "DupMint" }],
    });
    _injectBalances({ sol: 5.0, tokens: [] });

    const result = await tryDeploy({
      pool_address: "PoolTwo",
      base_mint: "DupMint",
      bin_step: 0.01,
    });

    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("base token") || result.reason.includes("Already holding"),
      `Got: ${result.reason}`
    );
  });

  // ── insufficient SOL ────────────────────────────────────────────────
  test("blocks deploy when SOL balance is insufficient", async () => {
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 0.01, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolLowSol", bin_step: 0.01 });

    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("Insufficient SOL") || result.reason.includes("SOL"),
      `Got: ${result.reason}`
    );
  });

  // ── token-only deploy bypasses SOL check ───────────────────────────
  test("token-only deploy (amount_x > 0) bypasses SOL balance check", async () => {
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    // Zero SOL would fail a normal deploy but not a token-only one
    _injectBalances({ sol: 0.0, tokens: [] });

    const result = await tryDeploy({
      pool_address: "PoolZ",
      base_mint: "TokenX",
      amount_x: 1000,
      amount_y: 0,
      bin_step: 0.01,
    });

    assert.notStrictEqual(result.blocked, true, `Should not block token-only deploy: ${JSON.stringify(result)}`);
  });
});
