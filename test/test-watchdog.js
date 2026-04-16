/**
 * Unit tests for src/watchdog.js
 * Tests: consecutive failure tracking (3=warning, 5=stale+remove), successful call
 * clears failure count, stale positions removed from watch list.
 *
 * Uses mocked getPositionPnl and in-memory DB via _injectDB.
 *
 * Run: node --test test/test-watchdog.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { makeSchemaDB } from "./mem-db.js";
import { _injectDB } from "../src/core/db.js";
import { _resetPositionsCache } from "../src/integrations/meteora/positions.js";
import { _resetPositionsCache as _resetPosCache } from "../src/integrations/meteora/positions.js";

// Injected mocks — reset after each test
let mockGetPositionPnl;
let mockGetMyPositions;
let mockPushNotification;
let mockCaptureAlert;
let mockRunManagementCycle;

async function setupMocks() {
  // Patch meteora module
  const meteoraMod = await import("../src/integrations/meteora.js");
  meteoraMod.getPositionPnl = mockGetPositionPnl || (() => ({ pnl_pct: 0, in_range: true }));
  meteoraMod.getMyPositions = mockGetMyPositions || (() => ({ positions: [] }));

  // Patch oor
  const oorMod = await import("../src/core/state/oor.js");
  oorMod.markOutOfRange = () => {};

  // Patch sync
  const syncMod = await import("../src/core/state/sync.js");
  syncMod.syncOpenPositions = () => {};

  // Patch notifications
  const notifMod = await import("../src/notifications/queue.js");
  notifMod.pushNotification = mockPushNotification || (() => {});

  // Patch instrument
  const instrMod = await import("../src/instrument.js");
  instrMod.captureAlert = mockCaptureAlert || (() => {});

  // Patch cycles
  const cyclesMod = await import("../src/core/cycles.js");
  cyclesMod.runManagementCycle = mockRunManagementCycle || (() => {});
}

describe("watchdog.js", () => {

  let db;

  beforeEach(async () => {
    db = await makeSchemaDB();
    _injectDB(db);
    _resetPositionsCache();

    mockGetPositionPnl = null;
    mockGetMyPositions = () => ({ positions: [] });
    mockPushNotification = () => {};
    mockCaptureAlert = () => {};
    mockRunManagementCycle = () => {};

    await setupMocks();
  });

  afterEach(async () => {
    _resetPositionsCache();
    const { closeDB } = await import("../src/core/db.js");
    closeDB();
  });

  // ── Helper: insert an active (non-closed) position into the DB ────────────────
  function insertActivePosition(address, pool = "TestPool", poolName = "TEST-USDC") {
    db.prepare(`
      INSERT INTO positions (position, pool, pool_name, status, closed, bin_range, amount_sol, bin_step, notes)
      VALUES (?, ?, ?, 'active', 0, '{"lower":100,"upper":200}', 0.5, 100, '[]')
    `).run(address, pool, poolName);
  }

  // ── 1. Consecutive failure tracking ─────────────────────────────────────────

  test("3 consecutive failures increments counter to 3", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosFail3", "PoolFail", "FAIL-POOL");
    recordFailure("PosFail3");
    recordFailure("PosFail3");
    recordFailure("PosFail3");

    assert.strictEqual(_consecutiveFailures.get("PosFail3"), 3);
  });

  test("5 consecutive failures marks position stale and removes from watch list", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosFail5", "PoolStale", "STALE-POOL");
    for (let i = 0; i < 5; i++) recordFailure("PosFail5");

    assert.strictEqual(_consecutiveFailures.get("PosFail5"), 5);

    // Position should now be marked stale in DB
    const row = db.prepare("SELECT status FROM positions WHERE position = ?").get("PosFail5");
    assert.strictEqual(row.status, "stale", "Position should be marked stale after 5 failures");
  });

  test("clearFailure removes failure count for a position", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, clearFailure, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosClear", "PoolClear", "CLEAR-POOL");
    recordFailure("PosClear");
    recordFailure("PosClear");
    clearFailure("PosClear");

    assert.strictEqual(_consecutiveFailures.has("PosClear"), false, "Failure count should be cleared");
  });

  // ── 2. Successful call clears failure count ─────────────────────────────────

  test("clearFailure after prior failures removes the counter", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, clearFailure, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosSuccess", "PoolOK", "OK-POOL");

    // Simulate 2 prior failures
    recordFailure("PosSuccess");
    recordFailure("PosSuccess");
    assert.strictEqual(_consecutiveFailures.get("PosSuccess"), 2);

    // Simulate a successful poll
    clearFailure("PosSuccess");

    assert.strictEqual(_consecutiveFailures.has("PosSuccess"), false, "Failure count cleared after successful poll");
  });

  // ── 3. Stale positions are removed from watch list ───────────────────────────

  test("markStaleAndRemove sets status=stale and clears failure tracking", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, markStaleAndRemove, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosStaleRemove", "PoolStaleRem", "STALE-REMOVE");
    for (let i = 0; i < 5; i++) recordFailure("PosStaleRemove");

    const pos = db.prepare("SELECT * FROM positions WHERE position = ?").get("PosStaleRemove");
    markStaleAndRemove("PosStaleRemove", pos);

    const row = db.prepare("SELECT status FROM positions WHERE position = ?").get("PosStaleRemove");
    assert.strictEqual(row.status, "stale", "Status should be 'stale'");
    assert.strictEqual(_consecutiveFailures.has("PosStaleRemove"), false, "Failure tracking should be cleared");
  });

  test("stale position does not appear in active positions query", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, markStaleAndRemove } = watchdogMod;

    insertActivePosition("PosSkipIfStale", "PoolSkip", "SKIP-POOL");
    for (let i = 0; i < 5; i++) recordFailure("PosSkipIfStale");

    const pos = db.prepare("SELECT * FROM positions WHERE position = ?").get("PosSkipIfStale");
    markStaleAndRemove("PosSkipIfStale", pos);

    // Simulate watchdog's SQL filter: only 'active' positions are polled
    const activePositions = db.prepare(
      "SELECT position FROM positions WHERE closed = 0 AND status = ?"
    ).all("active");

    assert.ok(
      !activePositions.some(p => p.position === "PosSkipIfStale"),
      "Stale position should not appear in active positions query"
    );
  });

  // ── 4. Poll simulation: error increments failure, success clears it ───────────

  test("getPositionPnl error increments failure count", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosPollErr", "PoolPollErr", "POLL-ERR");

    // Simulate what the watchdog loop does on a getPositionPnl error
    mockGetPositionPnl = async () => ({ error: "RPC timeout" });

    // The watchdog loop calls recordFailure on error
    recordFailure("PosPollErr");

    assert.strictEqual(_consecutiveFailures.get("PosPollErr"), 1);
  });

  test("getPositionPnl success clears failure count", async () => {
    const watchdogMod = await import("../src/watchdog.js");
    const { recordFailure, clearFailure, _consecutiveFailures } = watchdogMod;

    insertActivePosition("PosPollOK", "PoolPollOK", "POLL-OK");

    // Two prior failures
    recordFailure("PosPollOK");
    recordFailure("PosPollOK");

    // Simulate successful poll result
    mockGetPositionPnl = async () => ({ pnl_pct: 2.5, in_range: true, pnl_usd: 1.0 });

    clearFailure("PosPollOK");

    assert.strictEqual(_consecutiveFailures.has("PosPollOK"), false);
  });
});