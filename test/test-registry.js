/**
 * Unit tests for src/core/state/registry.js
 * Tests: trackPosition stores position, updatePositionStatus transitions,
 * getStateSummary counts, recordClose marks closed.
 * Uses async in-memory sql.js DB via _injectDB.
 *
 * Run: node --test test/test-registry.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { makeSchemaDB } from "./mem-db.js";
import { _injectDB } from "../src/core/db.js";
import { _resetPositionsCache, _injectPositionsCache } from "../src/integrations/meteora/positions.js";
import { _injectBalances } from "../src/integrations/helius.js";

describe("core/state/registry.js", () => {

  let db;

  beforeEach(async () => {
    db = await makeSchemaDB();
    _injectDB(db);
    _resetPositionsCache();
    _injectPositionsCache(null);
    _injectBalances(null);
  });

  afterEach(async () => {
    _resetPositionsCache();
    const { closeDB } = await import("../src/core/db.js");
    closeDB();
  });

  // ── trackPosition stores position ────────────────────────────────────────────

  test("trackPosition inserts a position row into the DB", async () => {
    const { trackPosition } = await import("../src/core/state/registry.js");

    trackPosition({
      position: "PosTest001",
      pool: "PoolAlpha",
      pool_name: "ALPHA-USDC",
      strategy: "bid_ask",
      bin_range: { lower: 100, upper: 200 },
      amount_sol: 0.5,
      amount_x: 0,
      active_bin: 150,
      bin_step: 100,
      volatility: 2.5,
      fee_tvl_ratio: 0.08,
      organic_score: 75,
      initial_value_usd: 75,
      base_mint: "TokenMintABC",
      market_phase: "normal",
    });

    const row = db.prepare("SELECT * FROM positions WHERE position = ?").get("PosTest001");
    assert.ok(row, "Position row should exist in DB");
    assert.strictEqual(row.position, "PosTest001");
    assert.strictEqual(row.pool, "PoolAlpha");
    assert.strictEqual(row.pool_name, "ALPHA-USDC");
    assert.strictEqual(row.strategy, "bid_ask");
    assert.strictEqual(row.status, "pending", "New position should be 'pending'");
    assert.strictEqual(row.closed, 0, "New position should not be closed");
    const binRange = JSON.parse(row.bin_range || "{}");
    assert.strictEqual(binRange.lower, 100);
    assert.strictEqual(binRange.upper, 200);
  });

  test("trackPosition allows multiple positions", async () => {
    const { trackPosition } = await import("../src/core/state/registry.js");

    trackPosition({ position: "PosA", pool: "PoolA", amount_sol: 0.1, bin_step: 100 });
    trackPosition({ position: "PosB", pool: "PoolB", amount_sol: 0.2, bin_step: 100 });

    const rows = db.prepare("SELECT position FROM positions ORDER BY position").all();
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map(r => r.position), ["PosA", "PosB"]);
  });

  // ── updatePositionStatus transitions work ────────────────────────────────────

  test("updatePositionStatus transitions from pending to active", async () => {
    const { trackPosition, updatePositionStatus } = await import("../src/core/state/registry.js");

    trackPosition({ position: "PosTrans001", pool: "PoolX", amount_sol: 0.1, bin_step: 100 });
    updatePositionStatus("PosTrans001", "active");

    const row = db.prepare("SELECT status FROM positions WHERE position = ?").get("PosTrans001");
    assert.strictEqual(row.status, "active");
  });

  test("updatePositionStatus transitions from active to closed", async () => {
    const { trackPosition, updatePositionStatus } = await import("../src/core/state/registry.js");

    trackPosition({ position: "PosTrans002", pool: "PoolY", amount_sol: 0.1, bin_step: 100 });
    updatePositionStatus("PosTrans002", "active");
    updatePositionStatus("PosTrans002", "closed");

    const row = db.prepare("SELECT status, closed FROM positions WHERE position = ?").get("PosTrans002");
    assert.strictEqual(row.status, "closed");
    assert.strictEqual(row.closed, 1);
  });

  // ── getStateSummary returns correct counts ───────────────────────────────────

  test("getStateSummary returns correct open_positions and closed_positions counts", async () => {
    const { trackPosition, updatePositionStatus, getStateSummary } = await import("../src/core/state/registry.js");

    trackPosition({ position: "Open1", pool: "P1", amount_sol: 0.1, bin_step: 100 });
    trackPosition({ position: "Open2", pool: "P2", amount_sol: 0.1, bin_step: 100 });
    trackPosition({ position: "Closed1", pool: "P3", amount_sol: 0.1, bin_step: 100 });

    updatePositionStatus("Closed1", "closed");

    const summary = getStateSummary();
    assert.strictEqual(summary.open_positions, 2, "Should have 2 open positions");
    assert.strictEqual(summary.closed_positions, 1, "Should have 1 closed position");
    assert.strictEqual(summary.positions.length, 2, "positions array should contain open positions only");
  });

  test("getStateSummary aggregates total_fees_claimed_usd", async () => {
    const { trackPosition, recordClaim, getStateSummary } = await import("../src/core/state/registry.js");

    trackPosition({ position: "FeePos1", pool: "PF1", amount_sol: 0.1, bin_step: 100 });
    trackPosition({ position: "FeePos2", pool: "PF2", amount_sol: 0.1, bin_step: 100 });

    recordClaim("FeePos1", 1.5);
    recordClaim("FeePos1", 2.5);  // cumulative
    recordClaim("FeePos2", 3.0);

    const summary = getStateSummary();
    // 1.5 + 2.5 + 3.0 = 7.0
    assert.strictEqual(summary.total_fees_claimed_usd, 7.0);
  });

  // ── recordClose marks position as closed ────────────────────────────────────

  test("recordClose sets closed=1, closed_at timestamp, and appends a note", async () => {
    const { trackPosition, recordClose, updatePositionStatus } = await import("../src/core/state/registry.js");

    trackPosition({ position: "ClosePos001", pool: "PoolZ", amount_sol: 0.1, bin_step: 100 });
    updatePositionStatus("ClosePos001", "active");
    await recordClose("ClosePos001", "Profit taken at 5%");

    const row = db.prepare("SELECT closed, closed_at, notes FROM positions WHERE position = ?").get("ClosePos001");
    assert.strictEqual(row.closed, 1, "closed flag should be 1");
    assert.ok(row.closed_at, "closed_at should be set");
    const notes = JSON.parse(row.notes || "[]");
    assert.ok(notes.some(n => n.includes("Profit taken")), "Note should mention the close reason");
  });

  // ── getTrackedPositions ──────────────────────────────────────────────────────

  test("getTrackedPositions(openOnly=true) returns only non-closed positions", async () => {
    const { trackPosition, updatePositionStatus, getTrackedPositions } = await import("../src/core/state/registry.js");

    trackPosition({ position: "Fil1", pool: "F1", amount_sol: 0.1, bin_step: 100 });
    trackPosition({ position: "Fil2", pool: "F2", amount_sol: 0.1, bin_step: 100 });
    trackPosition({ position: "Fil3", pool: "F3", amount_sol: 0.1, bin_step: 100 });

    updatePositionStatus("Fil1", "closed");

    const all = getTrackedPositions(false);
    const open = getTrackedPositions(true);

    assert.strictEqual(all.length, 3);
    assert.strictEqual(open.length, 2);
    assert.ok(open.every(p => p.closed === false), "All open positions should have closed=false");
  });

  // ── recordClaim ─────────────────────────────────────────────────────────────

  test("recordClaim increments total_fees_claimed_usd", async () => {
    const { trackPosition, recordClaim } = await import("../src/core/state/registry.js");

    trackPosition({ position: "ClaimPos1", pool: "CP1", amount_sol: 0.1, bin_step: 100 });
    recordClaim("ClaimPos1", 4.20);

    const row = db.prepare("SELECT total_fees_claimed_usd FROM positions WHERE position = ?").get("ClaimPos1");
    assert.strictEqual(row.total_fees_claimed_usd, 4.20);
  });
});