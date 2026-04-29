/**
 * Unit tests for src/core/state/oor.js — markOutOfRange / markInRange / minutesOutOfRange
 *
 * Tests the OOR single-source-of-truth write path used by updatePnlAndCheckExits.
 *
 * Run: WALLET_PRIVATE_KEY="[]" RPC_URL="https://api.mainnet-beta.solana.com" \
 *      OPENROUTER_API_KEY="test-key" node --test test/test-oor.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { _injectDB } from "../src/core/db.js";

// ─── Test DB factory ──────────────────────────────────────────────────────────

function makeInMemoryDB() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE positions (
      position              TEXT PRIMARY KEY,
      pool                 TEXT,
      pool_name            TEXT,
      strategy             TEXT,
      bin_range            TEXT,
      amount_sol           REAL,
      amount_x             REAL,
      active_bin_at_deploy INTEGER,
      bin_step             INTEGER,
      volatility           REAL,
      fee_tvl_ratio        REAL,
      organic_score        REAL,
      initial_value_usd    REAL,
      signal_snapshot      TEXT,
      base_mint            TEXT,
      deployed_at          TEXT,
      out_of_range_since   TEXT,
      last_claim_at        TEXT,
      total_fees_claimed_usd REAL,
      rebalance_count      INTEGER DEFAULT 0,
      closed               INTEGER DEFAULT 0,
      closed_at            TEXT,
      notes                TEXT DEFAULT '[]',
      peak_pnl_pct         REAL,
      prev_pnl_pct         REAL,
      trailing_active      INTEGER DEFAULT 0,
      instruction          TEXT,
      status               TEXT DEFAULT 'active',
      market_phase         TEXT,
      strategy_id          TEXT
    );
    CREATE TABLE recent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT, action TEXT, position TEXT, pool_name TEXT, reason TEXT
    );
  `);
  return db;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Insert a baseline position with deployed_at = now. */
function insertPosition(db, addr) {
  db.prepare(`
    INSERT INTO positions (position, pool, deployed_at, closed, status, out_of_range_since)
    VALUES (?, ?, ?, 0, 'active', NULL)
  `).run(addr, `pool-${addr}`, new Date().toISOString());
}

describe("core/state/oor.js — OOR tracking", () => {

  let db;

  beforeEach(async () => {
    db = makeInMemoryDB();
    _injectDB(db);
  });

  afterEach(async () => {
    const { closeDB } = await import("../src/core/db.js");
    closeDB();
  });

  // ── TEST 1: markOutOfRange sets out_of_range_since ───────────────────────────

  test("markOutOfRange sets out_of_range_since timestamp on first call", async () => {
    insertPosition(db, "OORPos001");

    const { markOutOfRange } = await import("../src/core/state/oor.js");

    markOutOfRange("OORPos001");

    const row = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("OORPos001");
    assert.ok(row.out_of_range_since, "out_of_range_since should be set");
    assert.ok(new Date(row.out_of_range_since).getTime() > 0, "Should be a valid ISO timestamp");
  });

  test("markOutOfRange is idempotent — second call does NOT update timestamp", async () => {
    insertPosition(db, "OORPos002");

    const { markOutOfRange } = await import("../src/core/state/oor.js");

    markOutOfRange("OORPos002");

    const row1 = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("OORPos002");
    const firstTS = row1.out_of_range_since;

    // Wait a moment so timestamps would differ
    await new Promise(resolve => setTimeout(resolve, 10));
    markOutOfRange("OORPos002");

    const row2 = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("OORPos002");
    assert.strictEqual(row2.out_of_range_since, firstTS, "Timestamp should not change on second call");
  });

  test("markOutOfRange does nothing if position is already OOR", async () => {
    insertPosition(db, "OORPos003");

    const { markOutOfRange } = await import("../src/core/state/oor.js");

    // Pre-set OOR timestamp
    const oldTS = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE positions SET out_of_range_since = ? WHERE position = ?").run(oldTS, "OORPos003");

    markOutOfRange("OORPos003");

    const row = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("OORPos003");
    assert.strictEqual(row.out_of_range_since, oldTS, "Timestamp should not change when already OOR");
  });

  test("markOutOfRange does nothing for non-existent position", async () => {
    const { markOutOfRange } = await import("../src/core/state/oor.js");

    // Should not throw — no-op for unknown address
    markOutOfRange("NonExistentPos999");
    // If we get here without throwing, the test passes
    assert.ok(true, "markOutOfRange on unknown position should be no-op");
  });

  // ── TEST 2: markInRange clears out_of_range_since ───────────────────────────

  test("markInRange clears out_of_range_since when position was OOR", async () => {
    insertPosition(db, "InRangePos001");

    const { markOutOfRange, markInRange } = await import("../src/core/state/oor.js");

    // Mark OOR first
    markOutOfRange("InRangePos001");
    const oorRow = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("InRangePos001");
    assert.ok(oorRow.out_of_range_since, "Precondition: position should be OOR");

    // Mark back in range
    markInRange("InRangePos001");

    const row = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("InRangePos001");
    assert.strictEqual(row.out_of_range_since, null, "out_of_range_since should be cleared");
  });

  test("markInRange is idempotent — calling on already-in-range position is no-op", async () => {
    insertPosition(db, "InRangePos002");

    const { markInRange } = await import("../src/core/state/oor.js");

    // out_of_range_since is already null
    markInRange("InRangePos002");

    const row = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get("InRangePos002");
    assert.strictEqual(row.out_of_range_since, null, "Should remain null");
  });

  test("markInRange does nothing for non-existent position", async () => {
    const { markInRange } = await import("../src/core/state/oor.js");

    markInRange("NonExistentPos998");
    assert.ok(true, "markInRange on unknown position should be no-op");
  });

  // ── TEST 3: minutesOutOfRange ───────────────────────────────────────────────

  test("minutesOutOfRange returns 0 when in range (no timestamp)", async () => {
    insertPosition(db, "MinPos001");

    const { minutesOutOfRange } = await import("../src/core/state/oor.js");

    const mins = minutesOutOfRange("MinPos001");
    assert.strictEqual(mins, 0, "Should return 0 when out_of_range_since is null");
  });

  test("minutesOutOfRange returns correct minutes after marking OOR", async () => {
    insertPosition(db, "MinPos002");

    const { minutesOutOfRange } = await import("../src/core/state/oor.js");

    // Backdate out_of_range_since by 5 minutes
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare("UPDATE positions SET out_of_range_since = ? WHERE position = ?").run(fiveMinsAgo, "MinPos002");

    const mins = minutesOutOfRange("MinPos002");
    assert.strictEqual(mins, 5, "Should return approximately 5 minutes OOR");
  });

  test("minutesOutOfRange returns 0 for non-existent position", async () => {
    const { minutesOutOfRange } = await import("../src/core/state/oor.js");

    const mins = minutesOutOfRange("GhostPos000");
    assert.strictEqual(mins, 0, "Non-existent position should return 0");
  });

  // ── TEST 4: Full OOR cycle — mark, wait, mark back in range ────────────────

  test("Full cycle: markOutOfRange → minutes grow → markInRange → minutes = 0", async () => {
    insertPosition(db, "CyclePos001");

    const { markInRange, minutesOutOfRange } = await import("../src/core/state/oor.js");

    // Initial state
    assert.strictEqual(minutesOutOfRange("CyclePos001"), 0, "Should start in range");

    // Mark OOR with a 10-minute-old timestamp
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE positions SET out_of_range_since = ? WHERE position = ?").run(tenMinsAgo, "CyclePos001");

    const minsWhileOOR = minutesOutOfRange("CyclePos001");
    assert.strictEqual(minsWhileOOR, 10, "Should report ~10 minutes out of range");

    // Mark back in range
    markInRange("CyclePos001");

    assert.strictEqual(minutesOutOfRange("CyclePos001"), 0, "Should be back in range with 0 minutes");
  });
});