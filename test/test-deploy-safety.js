/**
 * Unit tests for deploy safety checks in executor.js runSafetyChecks().
 * Tests: maxPositions, bin_step range, SOL balance, duplicate pool, duplicate base_mint,
 *        token-only deploy (amount_x > 0).
 *
 * Run: node --test test/test-deploy-safety.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// ─── In-memory test DB ─────────────────────────────────────────────────────────
import Database from "better-sqlite3";
import { _injectDB, initSchema } from "../src/core/db.js";
import { _injectPositionsCache, _resetPositionsCache } from "../src/integrations/meteora/positions.js";
import { _injectBalances } from "../src/integrations/helius.js";

function freshDB() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = OFF");
  initSchema(db); // use real schema (includes all tables: positions, strategies, etc.)
  return db;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("deploy_position safety checks", () => {

  let db;

  beforeEach(() => {
    db = freshDB();
    _injectDB(db);
    _injectPositionsCache(null); // reset any prior injection
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

  // ── Helper: call executeTool with deploy_position and return the result ───────
  async function tryDeploy(args) {
    const { executeTool } = await import("../src/tools/executor.js");
    return executeTool("deploy_position", args);
  }

  test("1. deploy_position blocked when positionCount >= maxPositions", async () => {
    db.prepare(`
      INSERT INTO positions (position, pool, base_mint, status, closed)
      VALUES ('pos1','pool1','mint1','active',0), ('pos2','pool2','mint2','active',0), ('pos3','pool3','mint3','active',0)
    `).run();

    const { config } = await import("../src/config.js");
    config.risk.maxPositions = 3;

    // Inject positions result showing 3 existing positions
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 3,
      positions: [
        { position: "pos1", pool: "pool1", base_mint: "mint1" },
        { position: "pos2", pool: "pool2", base_mint: "mint2" },
        { position: "pos3", pool: "pool3", base_mint: "mint3" },
      ],
    });

    const result = await tryDeploy({ pool_address: "NewPool", bin_step: 100 });
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("Max positions"), `Expected "Max positions" block reason, got: ${result.reason}`);
  });

  test("2a. deploy_position blocked for bin_step BELOW minBinStep", async () => {
    const { config } = await import("../src/config.js");
    config.screening.minBinStep = 80;

    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolUnderStep", bin_step: 50 });
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("bin_step"), `Expected bin_step block reason, got: ${result.reason}`);
  });

  test("2b. deploy_position blocked for bin_step ABOVE maxBinStep", async () => {
    const { config } = await import("../src/config.js");
    config.screening.maxBinStep = 125;

    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolOverStep", bin_step: 200 });
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("bin_step"), `Expected bin_step block reason, got: ${result.reason}`);
  });

  test("3. deploy_position blocked when SOL balance is below gas reserve", async () => {
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    // Wallet has only 0.10 SOL — well below gasReserve (0.2) + deploy amount
    _injectBalances({ sol: 0.10, sol_price: 150, tokens: [] });

    const result = await tryDeploy({ pool_address: "PoolLowBalance", bin_step: 100 });
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.toLowerCase().includes("insufficient sol"), `Expected insufficient SOL block, got: ${result.reason}`);
  });

  test("4. deploy_position blocked for duplicate pool_address", async () => {
    db.prepare(`
      INSERT INTO positions (position, pool, base_mint, status, closed)
      VALUES ('existingPos','DupPoolAddr','SomeMint','active',0)
    `).run();

    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "existingPos", pool: "DupPoolAddr", base_mint: "SomeMint" }],
    });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await tryDeploy({ pool_address: "DupPoolAddr", bin_step: 100 });
    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("duplicate") || result.reason.includes("Already have"),
      `Expected duplicate pool block, got: ${result.reason}`
    );
  });

  test("5. deploy_position blocked for duplicate base_mint", async () => {
    db.prepare(`
      INSERT INTO positions (position, pool, base_mint, status, closed)
      VALUES ('existingPos','SomeOtherPool','DupBaseMint','active',0)
    `).run();

    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "existingPos", pool: "SomeOtherPool", base_mint: "DupBaseMint" }],
    });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await tryDeploy({
      pool_address: "NewPoolForSameToken",
      base_mint: "DupBaseMint",
      bin_step: 100,
    });
    assert.strictEqual(result.blocked, true);
    assert.ok(
      result.reason.includes("base token") || result.reason.includes("Already holding"),
      `Expected base_mint duplicate block, got: ${result.reason}`
    );
  });

  // Token-only deploys (amount_x > 0) don't require SOL balance check — only gas
  test("token-only deploy (amount_x > 0) bypasses SOL balance requirement", async () => {
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5.0, sol_price: 150, tokens: [] });

    const result = await tryDeploy({
      pool_address: "TokenOnlyPool",
      base_mint: "SomeTokenMint",
      bin_step: 100,
      amount_x: 500,
      amount_y: 0,
    });

    assert.notStrictEqual(result.blocked, true, `Token-only deploy should not be blocked: ${JSON.stringify(result)}`);
  });

  test("7. deploy_position ALLOWED when SOL balance is sufficient and no other blocks", async () => {
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
    _injectBalances({ sol: 5, sol_price: 150, tokens: [] });

    const result = await tryDeploy({
      pool_address: "HealthyPool",
      bin_step: 100,
    });

    // Should not be blocked
    assert.notStrictEqual(result.blocked, true, `Should not be blocked with sufficient SOL, got: ${JSON.stringify(result)}`);
  });
});
