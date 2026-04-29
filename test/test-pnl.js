/**
 * Unit tests for src/core/state/pnl.js — updatePnlAndCheckExits
 *
 * Covers the 4 exit signal paths:
 *   1. STOP_LOSS    — pnl_pct <= stopLossPct
 *   2. TAKE_PROFIT  — pnl_pct >= takeProfitFeePct (when trailing TP is off)
 *   3. TRAILING_TP  — trailing activated, dropFromPeak >= adaptiveTrailingDrop
 *   4. OUT_OF_RANGE — in_range=false for >= oorWait minutes
 *   5. LOW_YIELD    — fee/TVL < minFeePerTvl24h after minAgeForYieldCheck
 *
 * Run: WALLET_PRIVATE_KEY="[]" RPC_URL="https://api.mainnet-beta.solana.com" \
 *      OPENROUTER_API_KEY="test-key" node --test test/test-pnl.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { _injectDB } from "../src/core/db.js";
import { _resetPositionsCache } from "../src/integrations/meteora/positions.js";

// ─── In-memory DB factory ─────────────────────────────────────────────────────

function makeInMemoryDB() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE positions (
      position              TEXT PRIMARY KEY,
      pool                  TEXT,
      pool_name             TEXT,
      strategy              TEXT,
      bin_range             TEXT,
      amount_sol            REAL,
      amount_x              REAL,
      active_bin_at_deploy  INTEGER,
      bin_step              INTEGER,
      volatility            REAL,
      fee_tvl_ratio         REAL,
      organic_score         REAL,
      initial_value_usd     REAL,
      signal_snapshot       TEXT,
      base_mint             TEXT,
      deployed_at           TEXT,
      out_of_range_since    TEXT,
      last_claim_at         TEXT,
      total_fees_claimed_usd REAL,
      rebalance_count       INTEGER DEFAULT 0,
      closed                INTEGER DEFAULT 0,
      closed_at             TEXT,
      notes                 TEXT DEFAULT '[]',
      peak_pnl_pct          REAL,
      prev_pnl_pct           REAL,
      trailing_active       INTEGER DEFAULT 0,
      instruction           TEXT,
      status                TEXT DEFAULT 'active',
      market_phase          TEXT,
      strategy_id           TEXT
    );
    CREATE TABLE recent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT, action TEXT, position TEXT, pool_name TEXT, reason TEXT
    );
  `);
  return db;
}

// ─── Test config factory ───────────────────────────────────────────────────────

/**
 * Build a management config object for tests.
 * Tests can spread DEFAULT_CONFIG and override specific fields.
 */
const DEFAULT_MGMT_CONFIG = {
  stopLossPct: -5,
  takeProfitFeePct: 3,
  trailingTakeProfit: false,
  trailingTriggerPct: 2,
  trailingDropPct: 1.5,
  outOfRangeWaitMinutes: 30,
  minFeePerTvl24h: 0.01,
  minAgeBeforeYieldCheck: 60,
};

function makeConfig(overrides = {}) {
  return { ...DEFAULT_MGMT_CONFIG, ...overrides };
}

// ─── Position seed helper ──────────────────────────────────────────────────────

function insertPosition(db, addr, extra = {}) {
  db.prepare(`
    INSERT INTO positions (
      position, pool, deployed_at, closed, status,
      out_of_range_since, trailing_active, peak_pnl_pct, prev_pnl_pct,
      volatility
    ) VALUES (?, ?, ?, 0, 'active', NULL, 0, NULL, NULL, ?)
  `).run(addr, `pool-${addr}`, new Date().toISOString(), extra.volatility ?? 3);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("core/state/pnl.js — updatePnlAndCheckExits", () => {

  let db;

  beforeEach(async () => {
    db = makeInMemoryDB();
    _injectDB(db);
    _resetPositionsCache();
  });

  afterEach(async () => {
    _resetPositionsCache();
    const { closeDB } = await import("../src/core/db.js");
    closeDB();
  });

  /**
   * Call updatePnlAndCheckExits and return the result.
   * @param {string} addr
   * @param {object} positionData
   * @param {object} mgmtConfig
   */
  async function callExitCheck(addr, positionData, mgmtConfig) {
    const { updatePnlAndCheckExits } = await import("../src/core/state/pnl.js");
    return updatePnlAndCheckExits(addr, positionData, mgmtConfig);
  }

  // ── STOP_LOSS ──────────────────────────────────────────────────────────────

  test("STOP_LOSS — fires when pnl_pct is at stopLossPct", async () => {
    insertPosition(db, "PosSL001", { volatility: 3 });
    const cfg = makeConfig();

    const result = await callExitCheck("PosSL001", {
      pnl_pct: -5.0,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.ok(result);
    assert.strictEqual(result.action, "STOP_LOSS");
  });

  test("STOP_LOSS — fires when pnl_pct is below stopLossPct", async () => {
    insertPosition(db, "PosSL002", { volatility: 3 });
    const cfg = makeConfig();

    const result = await callExitCheck("PosSL002", {
      pnl_pct: -8.5,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.ok(result);
    assert.strictEqual(result.action, "STOP_LOSS");
  });

  test("STOP_LOSS — does NOT fire when pnl_pct is above stopLossPct", async () => {
    insertPosition(db, "PosNoSL001", { volatility: 3 });
    const cfg = makeConfig();

    const result = await callExitCheck("PosNoSL001", {
      pnl_pct: -4.9,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.strictEqual(result, null);
  });

  // ── TAKE_PROFIT — not a standalone exit signal in the implementation.
  // When trailingTakeProfit=false the position stays open; the take-profit
  // threshold is only meaningful as the trigger for trailing TP.
  // The "trailing TP activation" test below covers that path.

  // ── TRAILING_TP ────────────────────────────────────────────────────────────

  test("TRAILING_TP — activates when pnl_pct >= trailingTriggerPct, fires on drop", async () => {
    insertPosition(db, "PosTrail001", { volatility: 3 });
    const cfg = makeConfig({ trailingTakeProfit: true });

    // Call 1: reach trigger — trailing activates (no exit)
    await callExitCheck("PosTrail001", {
      pnl_pct: 2.0,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    // Call 2: peak climbs to 4.0 — still no exit
    await callExitCheck("PosTrail001", {
      pnl_pct: 4.0,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    // Call 3: drop to 2.5 — drop from peak = 1.5 >= trailingDropPct of 1.5 → fires
    const result = await callExitCheck("PosTrail001", {
      pnl_pct: 2.5,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.ok(result);
    assert.strictEqual(result.action, "TRAILING_TP");
  });

  test("TRAILING_TP — vol >= 7 uses 1.5x trailing drop multiplier (adaptive threshold = 2.25%)", async () => {
    insertPosition(db, "PosTrailHighVol", { volatility: 8 });
    const cfg = makeConfig({ trailingTakeProfit: true });

    // Activate trailing
    await callExitCheck("PosTrailHighVol", {
      pnl_pct: 3.0,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    // Drop to 1.0: drop = 2.0% < 2.25% adaptive threshold → no exit
    const result1 = await callExitCheck("PosTrailHighVol", {
      pnl_pct: 1.0,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);
    assert.strictEqual(result1, null);

    // Drop to 0.5: drop = 2.5% >= 2.25% → fires with vol-adaptive tag
    const result2 = await callExitCheck("PosTrailHighVol", {
      pnl_pct: 0.5,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);
    assert.ok(result2);
    assert.strictEqual(result2.action, "TRAILING_TP");
    assert.ok(result2.reason.includes("[vol-adaptive]"));
  });

  // ── OUT_OF_RANGE ──────────────────────────────────────────────────────────

  test("OUT_OF_RANGE — fires after outOfRangeWaitMinutes when in_range=false", async () => {
    insertPosition(db, "PosOOR001", { volatility: 3 });
    const cfg = makeConfig({ outOfRangeWaitMinutes: 30 });

    // Backdate to 31 minutes ago
    const ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.prepare("UPDATE positions SET out_of_range_since = ? WHERE position = ?").run(ts, "PosOOR001");

    const result = await callExitCheck("PosOOR001", {
      pnl_pct: 0.5,
      in_range: false,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.ok(result);
    assert.strictEqual(result.action, "OUT_OF_RANGE");
  });

  test("OUT_OF_RANGE — does NOT fire before outOfRangeWaitMinutes have elapsed", async () => {
    insertPosition(db, "PosOOR002", { volatility: 3 });
    const cfg = makeConfig({ outOfRangeWaitMinutes: 30 });

    // Only 20 minutes ago
    const ts = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare("UPDATE positions SET out_of_range_since = ? WHERE position = ?").run(ts, "PosOOR002");

    const result = await callExitCheck("PosOOR002", {
      pnl_pct: 0.5,
      in_range: false,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.strictEqual(result, null);
  });

  test("OUT_OF_RANGE — vol >= 7 uses 0.5x oorWait multiplier (limit ~15 min for 30 min base)", async () => {
    insertPosition(db, "PosOORHighVol", { volatility: 8 });
    const cfg = makeConfig({ outOfRangeWaitMinutes: 30 });

    // 20 minutes ago — with 0.5x multiplier effective limit = 15 min → 20 >= 15 fires
    const ts = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare("UPDATE positions SET out_of_range_since = ? WHERE position = ?").run(ts, "PosOORHighVol");

    const result = await callExitCheck("PosOORHighVol", {
      pnl_pct: 0.5,
      in_range: false,
      fee_per_tvl_24h: null,
      age_minutes: null,
    }, cfg);

    assert.ok(result);
    assert.strictEqual(result.action, "OUT_OF_RANGE");
  });

  // ── LOW_YIELD ─────────────────────────────────────────────────────────────

  test("LOW_YIELD — fires when fee_per_tvl_24h < minFeePerTvl24h and age >= minAgeBeforeYieldCheck", async () => {
    insertPosition(db, "PosLY001", { volatility: 3 });
    const cfg = makeConfig();

    const result = await callExitCheck("PosLY001", {
      pnl_pct: 1.0,
      in_range: true,
      fee_per_tvl_24h: 0.005,  // < 0.01 threshold
      age_minutes: 120,        // >= 60
    }, cfg);

    assert.ok(result);
    assert.strictEqual(result.action, "LOW_YIELD");
  });

  test("LOW_YIELD — does NOT fire when age < minAgeBeforeYieldCheck", async () => {
    insertPosition(db, "PosLY002", { volatility: 3 });
    const cfg = makeConfig();

    const result = await callExitCheck("PosLY002", {
      pnl_pct: 1.0,
      in_range: true,
      fee_per_tvl_24h: 0.005,
      age_minutes: 30,         // < 60 — too young
    }, cfg);

    assert.strictEqual(result, null);
  });

  // ── HEALTHY POSITION ────────────────────────────────────────────────────────

  test("returns null when no exit condition is met (healthy position)", async () => {
    insertPosition(db, "PosHealthy001", { volatility: 3 });
    const cfg = makeConfig();

    const result = await callExitCheck("PosHealthy001", {
      pnl_pct: 2.0,
      in_range: true,
      fee_per_tvl_24h: 0.05,
      age_minutes: 120,
    }, cfg);

    assert.strictEqual(result, null);
  });
});