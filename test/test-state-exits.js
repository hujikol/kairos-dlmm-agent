/**
 * Unit tests for updatePnlAndCheckExits() in src/core/state.js
 * Uses Node's built-in test runner (node:test).
 *
 * Run: node --test test/test-state-exits.js
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "url";
import path from "path";
import { _makeMemDB } from "./mem-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTestDB() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS recent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT,
    position TEXT, pool_name TEXT, reason TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS pool_memory (
    pool_address TEXT PRIMARY KEY, name TEXT, base_mint TEXT,
    total_deploys INTEGER, avg_pnl_pct REAL, last_deploy_at TEXT, notes TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pair TEXT, tvl REAL,
    bin_step REAL, volatility REAL, oor INTEGER DEFAULT 0, pnl_pct REAL,
    tags TEXT, pinned INTEGER DEFAULT 0, lesson TEXT, created_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, position TEXT, pool TEXT,
    pool_name TEXT, strategy TEXT, bin_range TEXT, bin_step INTEGER,
    volatility REAL, fee_tvl_ratio REAL, organic_score REAL,
    initial_value_usd REAL, pnl_pct REAL, fees_claimed_usd REAL,
    duration_blocks INTEGER, oor INTEGER, stop_loss INTEGER,
    trailing_tp INTEGER, deployed_at TEXT, closed_at TEXT, notes TEXT
  )`);
  db.exec(`CREATE TABLE positions (
    position TEXT PRIMARY KEY, pool TEXT, pool_name TEXT, strategy TEXT, bin_range TEXT,
    amount_sol REAL, amount_x REAL, active_bin_at_deploy INTEGER, bin_step INTEGER,
    volatility REAL DEFAULT 3, fee_tvl_ratio REAL, organic_score REAL, initial_value_usd REAL,
    signal_snapshot TEXT, base_mint TEXT, deployed_at TEXT, out_of_range_since TEXT,
    last_claim_at TEXT, total_fees_claimed_usd REAL, rebalance_count INTEGER,
    closed INTEGER DEFAULT 0, closed_at TEXT, notes TEXT DEFAULT '[]',
    peak_pnl_pct REAL, prev_pnl_pct REAL, trailing_active INTEGER DEFAULT 0,
    instruction TEXT, status TEXT DEFAULT 'active', market_phase TEXT, strategy_id TEXT
  )`);
  return db;
}

const testDb = makeTestDB();
const { _injectDB } = await import("../src/core/db.js");
_injectDB(testDb);
const { updatePnlAndCheckExits } = await import("../src/core/state.js");

function insertPosition(overrides = {}) {
  const pos = {
    position: "Pos001", pool: "PoolX", pool_name: "Pool X", status: "active",
    closed: 0, peak_pnl_pct: 0, prev_pnl_pct: null, trailing_active: 0,
    out_of_range_since: null, volatility: 3, bin_range: "{}", signal_snapshot: "null",
    notes: "[]", strategy: null, amount_sol: null, amount_x: null, base_mint: null,
    deployed_at: null, last_claim_at: null, total_fees_claimed_usd: null,
    rebalance_count: 0, closed_at: null, instruction: null, market_phase: null, strategy_id: null,
    ...overrides,
  };
  const cols = Object.keys(pos).join(", ");
  const ph = Object.keys(pos).map(() => "?").join(", ");
  testDb.prepare(`INSERT INTO positions (${cols}) VALUES (${ph})`).run(...Object.values(pos));
}

function defaultMgmtConfig() {
  return { trailingTakeProfit: true, trailingTriggerPct: 3, trailingDropPct: 1.5, stopLossPct: -50, outOfRangeWaitMinutes: 30, minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 };
}

beforeEach(() => {
  testDb.exec("DELETE FROM positions");
  testDb.exec("DELETE FROM recent_events");
  testDb.exec("DELETE FROM lessons");
  testDb.exec("DELETE FROM kv_store");
});

// ─── STOP LOSS ────────────────────────────────────────────────────────────────
describe("STOP_LOSS", () => {
  test("triggers when currentPnlPct equals stopLossPct", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: -50, in_range: true, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), stopLossPct: -50 });
    assert.strictEqual(result?.action, "STOP_LOSS");
    assert.ok(result?.reason.includes("-50.00%"));
  });
  test("triggers when currentPnlPct is below stopLossPct", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: -75, in_range: true, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), stopLossPct: -50 });
    assert.strictEqual(result?.action, "STOP_LOSS");
    assert.ok(result?.reason.includes("-75.00%"));
  });
  test("does NOT trigger when pnl is above stopLossPct", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: -10, in_range: true, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), stopLossPct: -50 });
    assert.strictEqual(result, null);
  });
  test("does NOT trigger when pnl is just above stopLossPct", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: -49.99, in_range: true, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), stopLossPct: -50 });
    assert.strictEqual(result, null);
  });
});

// ─── TRAILING TP ACTIVATION ─────────────────────────────────────────────────
describe("TRAILING_TP activation", () => {
  test("activates trailing when PnL reaches trailingTriggerPct", () => {
    insertPosition({ peak_pnl_pct: 0, trailing_active: 0 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 3, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
    assert.strictEqual(testDb.prepare("SELECT trailing_active FROM positions WHERE position=?").get("Pos001").trailing_active, 1);
    assert.strictEqual(testDb.prepare("SELECT peak_pnl_pct FROM positions WHERE position=?").get("Pos001").peak_pnl_pct, 3);
  });
  test("does NOT activate trailing below trigger threshold", () => {
    insertPosition({ peak_pnl_pct: 0, trailing_active: 0 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 2.9, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
    assert.strictEqual(testDb.prepare("SELECT trailing_active FROM positions WHERE position=?").get("Pos001").trailing_active, 0);
  });
  test("does NOT re-activate trailing if already active", () => {
    insertPosition({ peak_pnl_pct: 5, trailing_active: 1 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 8, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
    assert.strictEqual(testDb.prepare("SELECT trailing_active FROM positions WHERE position=?").get("Pos001").trailing_active, 1);
    assert.strictEqual(testDb.prepare("SELECT peak_pnl_pct FROM positions WHERE position=?").get("Pos001").peak_pnl_pct, 8);
  });
  test("does NOT activate trailing when trailingTakeProfit config flag is false", () => {
    insertPosition({ peak_pnl_pct: 0, trailing_active: 0 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), trailingTakeProfit: false });
    assert.strictEqual(result, null);
    assert.strictEqual(testDb.prepare("SELECT trailing_active FROM positions WHERE position=?").get("Pos001").trailing_active, 0);
  });
});

// ─── TRAILING TP TRIGGER ─────────────────────────────────────────────────────
describe("TRAILING_TP trigger (after activation)", () => {
  test("triggers when peak minus current >= trailingDropPct", () => {
    insertPosition({ peak_pnl_pct: 10, trailing_active: 1 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 8.5, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result?.action, "TRAILING_TP");
    assert.ok(result?.reason.includes("peak"));
  });
  test("does NOT trigger when drop is below threshold", () => {
    insertPosition({ peak_pnl_pct: 10, trailing_active: 1 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 9.0, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
  });
  test("high volatility (>=7) scales trailingDropPct by 1.5x — does NOT trigger at 2.0% drop", () => {
    insertPosition({ peak_pnl_pct: 10, trailing_active: 1, volatility: 7 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 8.0, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
  });
  test("high volatility (>=7) DOES trigger trailing TP at 2.26% drop", () => {
    insertPosition({ peak_pnl_pct: 10, trailing_active: 1, volatility: 7 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 7.74, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result?.action, "TRAILING_TP");
    assert.ok(result?.reason.includes("[vol-adaptive]"));
  });
});

// ─── OUT OF RANGE TIMEOUT ───────────────────────────────────────────────────
describe("OUT_OF_RANGE timeout", () => {
  test("does NOT trigger when OOR for less than outOfRangeWaitMinutes", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 15*60*1000).toISOString() });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
  });
  test("triggers when OOR for longer than outOfRangeWaitMinutes", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 31*60*1000).toISOString() });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), outOfRangeWaitMinutes: 30 });
    assert.strictEqual(result?.action, "OUT_OF_RANGE");
    assert.ok(result?.reason.includes("31m"));
  });
  test("does NOT trigger when position returns in range (OOR timestamp cleared)", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 60*60*1000).toISOString() });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
    assert.strictEqual(testDb.prepare("SELECT out_of_range_since FROM positions WHERE position=?").get("Pos001").out_of_range_since, null);
  });
  test("does NOT trigger when position just went OOR (timestamp is fresh)", () => {
    insertPosition({ out_of_range_since: new Date().toISOString() });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
  });
  test("volatility >=7 halves OOR wait time (50%)", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 16*60*1000).toISOString(), volatility: 7 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result?.action, "OUT_OF_RANGE");
    assert.ok(result?.reason.includes("[vol-adaptive"));
  });
  test("volatility >=4 but <7 uses 75% of OOR wait time", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 23*60*1000).toISOString(), volatility: 4 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result?.action, "OUT_OF_RANGE");
    assert.ok(result?.reason.includes("[vol-adaptive"));
  });
  test("OOR exit reason includes the wait-limit value", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 31*60*1000).toISOString() });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), outOfRangeWaitMinutes: 30 });
    assert.ok(result?.reason.includes("limit: 30m"));
  });
});

// ─── LOW YIELD ─────────────────────────────────────────────────────────────
describe("LOW_YIELD exit", () => {
  test("triggers when fee_per_tvl_24h is below threshold and position is old enough", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: 5, age_minutes: 120 }, { ...defaultMgmtConfig(), minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 });
    assert.strictEqual(result?.action, "LOW_YIELD");
    assert.ok(result?.reason.includes("5.00%"));
  });
  test("does NOT trigger when fee_per_tvl_24h is at or above threshold", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: 7.5, age_minutes: 120 }, { ...defaultMgmtConfig(), minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 });
    assert.strictEqual(result, null);
  });
  test("does NOT trigger when position is too young", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: 3, age_minutes: 10 }, { ...defaultMgmtConfig(), minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 });
    assert.strictEqual(result, null);
  });
  test("does NOT trigger when age_minutes is null (age unknown)", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: 3, age_minutes: null }, { ...defaultMgmtConfig(), minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 });
    assert.strictEqual(result, null);
  });
  test("does NOT trigger when fee_per_tvl_24h is null", () => {
    insertPosition();
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: null, age_minutes: 120 }, { ...defaultMgmtConfig(), minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 });
    assert.strictEqual(result, null);
  });
});

// ─── PEAK PNL TRACKING ─────────────────────────────────────────────────────
describe("peak_pnl_pct tracking", () => {
  test("updates peak_pnl_pct when current PnL exceeds previous peak", () => {
    insertPosition({ peak_pnl_pct: 5 });
    updatePnlAndCheckExits("Pos001", { pnl_pct: 8, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(testDb.prepare("SELECT peak_pnl_pct FROM positions WHERE position=?").get("Pos001").peak_pnl_pct, 8);
  });
  test("does NOT update peak_pnl_pct when current PnL is below peak", () => {
    insertPosition({ peak_pnl_pct: 10 });
    updatePnlAndCheckExits("Pos001", { pnl_pct: 7, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(testDb.prepare("SELECT peak_pnl_pct FROM positions WHERE position=?").get("Pos001").peak_pnl_pct, 10);
  });
  test("updates peak_pnl_pct on first reading when current > 0 and peak is 0", () => {
    insertPosition({ peak_pnl_pct: 0 });
    updatePnlAndCheckExits("Pos001", { pnl_pct: 1.5, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(testDb.prepare("SELECT peak_pnl_pct FROM positions WHERE position=?").get("Pos001").peak_pnl_pct, 1.5);
  });
});

// ─── OUT_OF_RANGE SINCE PERSISTENCE ─────────────────────────────────────────
describe("out_of_range_since persistence", () => {
  test("sets out_of_range_since when position first goes OOR", () => {
    insertPosition({ out_of_range_since: null });
    updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.ok(testDb.prepare("SELECT out_of_range_since FROM positions WHERE position=?").get("Pos001").out_of_range_since !== null);
  });
  test("clears out_of_range_since when position returns in range", () => {
    insertPosition({ out_of_range_since: new Date(Date.now() - 60*60*1000).toISOString() });
    updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(testDb.prepare("SELECT out_of_range_since FROM positions WHERE position=?").get("Pos001").out_of_range_since, null);
  });
  test("does NOT reset out_of_range_since when already set and in_range is false again", () => {
    const oldTs = new Date(Date.now() - 60*60*1000).toISOString();
    insertPosition({ out_of_range_since: oldTs });
    updatePnlAndCheckExits("Pos001", { pnl_pct: 5, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(testDb.prepare("SELECT out_of_range_since FROM positions WHERE position=?").get("Pos001").out_of_range_since, oldTs);
  });
});

// ─── PREV_PNL_PCT PERSISTENCE ─────────────────────────────────────────────
describe("prev_pnl_pct tracking", () => {
  test("persists currentPnlPct as prev_pnl_pct for next cycle", () => {
    insertPosition();
    updatePnlAndCheckExits("Pos001", { pnl_pct: -3.5, in_range: true, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(testDb.prepare("SELECT prev_pnl_pct FROM positions WHERE position=?").get("Pos001").prev_pnl_pct, -3.5);
  });
});

// ─── EDGE CASES ─────────────────────────────────────────────────────────────
describe("edge cases", () => {
  test("returns null when position is closed", () => {
    insertPosition({ closed: 1, status: "closed" });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: -60, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
  });
  test("returns null when position address not found in registry", () => {
    const result = updatePnlAndCheckExits("NonExistent", { pnl_pct: -60, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result, null);
  });
  test("stop loss takes precedence over trailing TP when both could fire", () => {
    insertPosition({ peak_pnl_pct: 5, trailing_active: 1 });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: -60, in_range: true, fee_per_tvl_24h: null }, { ...defaultMgmtConfig(), stopLossPct: -50 });
    assert.strictEqual(result?.action, "STOP_LOSS");
  });
  test("trailing TP is checked before OOR and fires first when both conditions are met", () => {
    insertPosition({ peak_pnl_pct: 10, trailing_active: 1, out_of_range_since: new Date(Date.now() - 31*60*1000).toISOString() });
    const result = updatePnlAndCheckExits("Pos001", { pnl_pct: 8.4, in_range: false, fee_per_tvl_24h: null }, defaultMgmtConfig());
    assert.strictEqual(result?.action, "TRAILING_TP");
  });
});
