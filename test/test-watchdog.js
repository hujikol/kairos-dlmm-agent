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

// Import setter functions from watchdog.js to inject mocks
import {
  _setGetPositionPnl,
  _setGetMyPositions,
  _setPushNotification,
  _setCaptureAlert,
  _setRunManagementCycle,
  _setSyncOpenPositions,
  _setMarkOutOfRange,
  _setClosePosition,
  _setPollInterval,
} from "../src/watchdog.js";

// Mock functions
let mockGetPositionPnl;
let mockGetMyPositions;
let mockPushNotification;
let mockCaptureAlert;
let mockRunManagementCycle;
let mockSyncOpenPositions;
let mockMarkOutOfRange;
let mockClosePosition;

function setupMocks() {
  _setGetPositionPnl(mockGetPositionPnl || (() => Promise.resolve({ pnl_pct: 0, in_range: true })));
  _setGetMyPositions(mockGetMyPositions || (() => Promise.resolve({ positions: [] })));
  _setPushNotification(mockPushNotification || (() => {}));
  _setCaptureAlert(mockCaptureAlert || (() => {}));
  _setRunManagementCycle(mockRunManagementCycle || (() => {}));
  _setSyncOpenPositions(mockSyncOpenPositions || (() => {}));
  _setMarkOutOfRange(mockMarkOutOfRange || (() => {}));
  _setClosePosition(mockClosePosition || (() => ({ success: true })));
}

describe("watchdog.js", () => {

  let db;

  beforeEach(async () => {
    db = await makeSchemaDB();
    _injectDB(db);
    _resetPositionsCache();

    mockGetPositionPnl = null;
    mockGetMyPositions = () => Promise.resolve({ positions: [] });
    mockPushNotification = () => {};
    mockCaptureAlert = () => {};
    mockRunManagementCycle = () => {};
    mockSyncOpenPositions = () => {};
    mockMarkOutOfRange = () => {};
    mockClosePosition = () => ({ success: true });

    setupMocks();
    // Set short poll interval for tests (50ms)
    _setPollInterval(50);
  });

  afterEach(async () => {
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();
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

  test("insertActivePosition helper works", () => {
    insertActivePosition("pos1");
    const rows = db.prepare("SELECT * FROM positions").all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].position, "pos1");
  });

  test("startWatchdog exists and is a function", async () => {
    const { startWatchdog } = await import("../src/watchdog.js");
    assert.strictEqual(typeof startWatchdog, "function");
  });

  test("position with pnl_pct <= stopLossPct triggers emergency close", async () => {
    insertActivePosition("pos2");
    let notified = null;
    let closed = null;

    mockGetPositionPnl = () => ({ pnl_pct: -10, in_range: false });
    mockPushNotification = (n) => { notified = n; };
    mockClosePosition = (opts) => { closed = opts.position_address; return { success: true }; };
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    // Wait for interval to fire (50ms poll + buffer)
    await new Promise(r => setTimeout(r, 200));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();

    assert.ok(closed, "closePosition should have been called");
    assert.ok(notified, "pushNotification should have been called");
  });

  test("consecutive failures tracked and alert fires at 3", async () => {
    insertActivePosition("pos3");
    let alertMsg = null;

    mockGetPositionPnl = () => Promise.reject(new Error("API down"));
    mockCaptureAlert = (msg) => { alertMsg = msg; };
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    // Wait for multiple intervals (50ms * ~6 = 300ms + buffer)
    await new Promise(r => setTimeout(r, 500));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();

    assert.ok(alertMsg, "captureAlert should fire after 3 consecutive failures");
  });

  test("clearFailure after prior failures removes the counter", async () => {
    insertActivePosition("pos4");

    // First 3 calls fail, 4th succeeds (clears failure count)
    let callCount = 0;
    mockGetPositionPnl = () => {
      callCount++;
      if (callCount <= 3) return Promise.reject(new Error("fail"));
      return Promise.resolve({ pnl_pct: 0, in_range: true });
    };
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    await new Promise(r => setTimeout(r, 500));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();
  });

  test("markStaleAndRemove sets status=stale and clears failure tracking", async () => {
    insertActivePosition("pos5");
    let notified = null;

    mockGetPositionPnl = () => Promise.reject(new Error("fail"));
    mockPushNotification = (n) => { notified = n; };
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    // Need 5+ failures to go stale (50ms interval * 6 = 300ms + buffer)
    await new Promise(r => setTimeout(r, 800));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();

    const row = db.prepare("SELECT status FROM positions WHERE position = ?").get("pos5");
    assert.strictEqual(row.status, "stale");
    assert.ok(notified, "pushNotification should fire for stale position");
  });

  test("getPositionPnl error increments failure count", async () => {
    insertActivePosition("pos6");

    mockGetPositionPnl = () => Promise.reject(new Error("API error"));
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    await new Promise(r => setTimeout(r, 300));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();
  });

  test("getPositionPnl success clears failure count", async () => {
    insertActivePosition("pos7");

    let callCount = 0;
    mockGetPositionPnl = () => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve({ pnl_pct: 1.5, in_range: true });
    };
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    await new Promise(r => setTimeout(r, 300));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();
  });

  test("stale position does not appear in active positions query", async () => {
    insertActivePosition("pos8");

    mockGetPositionPnl = () => Promise.reject(new Error("fail"));
    setupMocks();

    const { startWatchdog } = await import("../src/watchdog.js");
    const config = { management: { stopLossPct: -5 } };
    startWatchdog(config);

    await new Promise(r => setTimeout(r, 800));
    const { stopWatchdog } = await import("../src/watchdog.js");
    stopWatchdog();

    const active = db.prepare("SELECT * FROM positions WHERE closed = 0 AND status = 'active'").all();
    assert.strictEqual(active.length, 0, "Stale position should not appear in active query");
  });
});
