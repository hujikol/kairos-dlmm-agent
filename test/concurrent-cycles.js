import "dotenv/config";

/**
 * Integration tests for concurrent cycle guards and positions cache deduplication.
 *
 * Tests:
 * 1. runScreeningCycle() returns null when _screeningBusy is already set
 * 2. runManagementCycle() returns null when _managementBusy is already set
 * 3. _busyState flags are reset after a cycle completes
 * 4. getMyPositions() _positionsInflight deduplication - concurrent calls share one promise
 *
 * Run: node --test test/concurrent-cycles.js
 */

import { test, describe, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";

process.env.DRY_RUN = "true";

after(async () => {
  const { closeDB } = await import("../src/core/db.js");
  const { stopCronJobs } = await import("../src/core/scheduler.js");
  const { stopWatchdog } = await import("../src/watchdog.js");
  stopCronJobs();
  stopWatchdog();
  await closeDB();
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

function freshDB() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = OFF");
  return db;
}

// Stub/restore agent-gateway to break the broken import chain.
// The real agent-gateway.js imports agentLoop which eventually pulls in
// src/tools/positions.js which references a non-existent close-accounts.js.
async function stubAgentGateway() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const fs = await import("fs");
  const path = req.resolve("../src/core/agent-gateway.js");
  const original = fs.readFileSync(path, "utf8");
const stub = `export class AgentGateway {
  constructor() {}
  async runManagementCycle() {
    if (globalThis.__KAIROS_TEST_GATEWAY_DELAY) await globalThis.__KAIROS_TEST_GATEWAY_DELAY;
    return { content: "" };
  }
  async runScreeningCycle() {
    if (globalThis.__KAIROS_TEST_GATEWAY_DELAY) await globalThis.__KAIROS_TEST_GATEWAY_DELAY;
    return { content: "", partialResult: null, toolFailed: null };
  }
}
export const defaultGateway = new AgentGateway();
`;
  fs.writeFileSync(path, stub, "utf8");
  return original;
}

async function restoreAgentGateway(original) {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const fs = await import("fs");
  const path = req.resolve("../src/core/agent-gateway.js");
  fs.writeFileSync(path, original, "utf8");
}

// Inject a fake getWallet() so getMyPositions() proceeds past the decode step
// without throwing "Non-base58 character".
async function injectFakeWallet() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const fs = await import("fs");
  const path = req.resolve("../src/integrations/meteora/pool.js");
  const original = fs.readFileSync(path, "utf8");
  const patched = original.replace(
    /export function getWallet\(\)[\s\S]*?^}/m,
    `export function getWallet() {
  if (!_wallet) {
    class FakeKeypair {
      constructor() {
        this.publicKey = { toString: () => "TestWallet1111111111111111111111111111111" };
      }
    }
    _wallet = new FakeKeypair();
  }
  return _wallet;
}`
  );
  fs.writeFileSync(path, patched, "utf8");
  return original;
}

async function restorePool(original) {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const fs = await import("fs");
  const path = req.resolve("../src/integrations/meteora/pool.js");
  fs.writeFileSync(path, original, "utf8");
}

describe("concurrent-cycles", { concurrency: false }, () => {

  // ── Test 1a: direct guard check — pre-set flag, verify null return ────────
  test("runScreeningCycle() returns null when _screeningBusy is already true", async () => {
    const originalGateway = await stubAgentGateway();
    try {
      const { _injectDB } = await import("../src/core/db.js");
      _injectDB(freshDB());

      const { _injectBalances } = await import("../src/integrations/helius.js");
      _injectBalances({ sol: 10.0, usd: 300, tokens: [] });

      const { _injectPositionsCache } = await import("../src/integrations/meteora/positions.js");
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      const { _injectDiscovery } = await import("../src/screening/discovery.js");
      _injectDiscovery({ pools: [] });

      const { _injectDailyPnL, _injectCircuitBreaker } = await import("../src/core/daily-tracker.js");
      _injectDailyPnL({ realized: 0, unrealized: 0 });
      _injectCircuitBreaker({ action: "trade", reason: "normal" });

      const stateMod = await import("../src/core/state/scheduler-state.js");
      const _busyState = stateMod._busyState;
      _busyState._screeningBusy = false;
      _busyState._managementBusy = false;

      const cyclesMod = await import("../src/core/cycles.js");
      const runScreeningCycle = cyclesMod.runScreeningCycle;

      // Pre-set busy flag to simulate "already running"
      _busyState._screeningBusy = true;
      const result = await runScreeningCycle({ silent: true });
      assert.strictEqual(result, null, "runScreeningCycle() should return null when _screeningBusy is already true");
      assert.strictEqual(_busyState._screeningBusy, true, "_screeningBusy should still be true (guard rejected entry)");

      _busyState._screeningBusy = false;
    } finally {
      const { _busyState } = await import("../src/core/state/scheduler-state.js");
      _busyState._screeningBusy = false;
      _busyState._managementBusy = false;
      await restoreAgentGateway(originalGateway);
    }
  });

  // ── Test 1b: concurrent timing — first sets flag, second call is blocked ───
  test("second runScreeningCycle() is blocked while first is running", async () => {
    const originalGateway = await stubAgentGateway();
    try {
      const { _injectDB } = await import("../src/core/db.js");
      _injectDB(freshDB());

      const { _injectBalances } = await import("../src/integrations/helius.js");
      _injectBalances({ sol: 10.0, usd: 300, tokens: [] });

      const { _injectPositionsCache } = await import("../src/integrations/meteora/positions.js");
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      // Inject delayed discovery to keep first cycle in-flight
      const { _injectDiscovery } = await import("../src/screening/discovery.js");
      let unblockFirst = null;
      const firstDelay = new Promise(resolve => { unblockFirst = resolve; });
      _injectDiscovery({ pools: [], _delay: firstDelay });

      const { _injectDailyPnL, _injectCircuitBreaker } = await import("../src/core/daily-tracker.js");
      _injectDailyPnL({ realized: 0, unrealized: 0 });
      _injectCircuitBreaker({ action: "trade", reason: "normal" });

      const stateMod = await import("../src/core/state/scheduler-state.js");
      const _busyState = stateMod._busyState;
      _busyState._screeningBusy = false;
      _busyState._managementBusy = false;

      const cyclesMod = await import("../src/core/cycles.js");
      const runScreeningCycle = cyclesMod.runScreeningCycle;

      assert.strictEqual(_busyState._screeningBusy, false, "screening busy should be false initially");

      const firstRun = runScreeningCycle({ silent: true });
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.strictEqual(_busyState._screeningBusy, true, "screening busy should be true during first run");

      const secondResult = await runScreeningCycle({ silent: true });
      assert.strictEqual(secondResult, null, "second runScreeningCycle() should return null (blocked)");
      assert.strictEqual(_busyState._screeningBusy, true, "screening busy still true");

      unblockFirst();
      await firstRun.catch(() => {});

      assert.strictEqual(_busyState._screeningBusy, false, "screening busy should be false after first cycle completes");
    } finally {
      const { _busyState } = await import("../src/core/state/scheduler-state.js");
      _busyState._screeningBusy = false;
      _busyState._managementBusy = false;
      await restoreAgentGateway(originalGateway);
    }
  });

  // ── Test 2a: direct guard check for management cycle ───────────────────────
  test("runManagementCycle() returns null when _managementBusy is already true", async () => {
    const originalGateway = await stubAgentGateway();
    try {
      const { _injectDB } = await import("../src/core/db.js");
      _injectDB(freshDB());

      const { _injectBalances } = await import("../src/integrations/helius.js");
      _injectBalances({ sol: 10.0, usd: 300, tokens: [] });

      const { _injectPositionsCache } = await import("../src/integrations/meteora/positions.js");
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      const { _injectDailyPnL, _injectCircuitBreaker } = await import("../src/core/daily-tracker.js");
      _injectDailyPnL({ realized: 0, unrealized: 0 });
      _injectCircuitBreaker({ action: "trade", reason: "normal" });

      const stateMod = await import("../src/core/state/scheduler-state.js");
      const _busyState = stateMod._busyState;
      _busyState._managementBusy = false;

      const cyclesMod = await import("../src/core/cycles.js");
      const runManagementCycle = cyclesMod.runManagementCycle;

      _busyState._managementBusy = true;
      const result = await runManagementCycle({ silent: true });
      assert.strictEqual(result, null, "runManagementCycle() should return null when _managementBusy is already true");
      assert.strictEqual(_busyState._managementBusy, true, "_managementBusy should still be true");

      _busyState._managementBusy = false;
    } finally {
      await restoreAgentGateway(originalGateway);
    }
  });

  test("second runManagementCycle() is blocked while first is running", async () => {
    const originalGateway = await stubAgentGateway();
    try {
      const { _injectDB } = await import("../src/core/db.js");
      _injectDB(freshDB());

      const { _injectBalances } = await import("../src/integrations/helius.js");
      _injectBalances({ sol: 10.0, usd: 300, tokens: [] });

      const { _injectPositionsCache } = await import("../src/integrations/meteora/positions.js");
      _injectPositionsCache({
        wallet: "TestWallet",
        total_positions: 1,
        positions: [{
          position: "PosInstruction",
          pool: "PoolInstruction",
          pair: "TEST/SOL",
          in_range: true,
          pnl_pct: 0,
          pnl_usd: 0,
          total_value_usd: 10,
          unclaimed_fees_usd: 0,
          fee_per_tvl_24h: 0,
          minutes_out_of_range: 0,
          age_minutes: 30,
          instruction: "hold unless test says close",
        }],
      });

      const { _injectDailyPnL, _injectCircuitBreaker } = await import("../src/core/daily-tracker.js");
      _injectDailyPnL({ realized: 0, unrealized: 0 });
      _injectCircuitBreaker({ action: "trade", reason: "normal" });

      const stateMod = await import("../src/core/state/scheduler-state.js");
      const _busyState = stateMod._busyState;
      _busyState._managementBusy = false;

      const cyclesMod = await import("../src/core/cycles.js");
      const runManagementCycle = cyclesMod.runManagementCycle;

      assert.strictEqual(_busyState._managementBusy, false, "management busy should be false initially");

      let unblockFirst = null;
      globalThis.__KAIROS_TEST_GATEWAY_DELAY = new Promise(resolve => { unblockFirst = resolve; });
      const firstRun = runManagementCycle({ silent: true });
      await new Promise(resolve => setTimeout(resolve, 20));

      assert.strictEqual(_busyState._managementBusy, true, "management busy should be true during first run");

      const secondResult = await runManagementCycle({ silent: true });
      assert.strictEqual(secondResult, null, "second runManagementCycle() should return null (blocked)");
      assert.strictEqual(_busyState._managementBusy, true, "management busy still true");

      unblockFirst();
      await firstRun.catch(() => {});
      globalThis.__KAIROS_TEST_GATEWAY_DELAY = null;

      assert.strictEqual(_busyState._managementBusy, false, "management busy should be false after first cycle completes");
    } finally {
      globalThis.__KAIROS_TEST_GATEWAY_DELAY = null;
      const { _busyState } = await import("../src/core/state/scheduler-state.js");
      _busyState._screeningBusy = false;
      _busyState._managementBusy = false;
      await restoreAgentGateway(originalGateway);
    }
  });

  test("_busyState flags are reset after a cycle completes", async () => {
    const originalGateway = await stubAgentGateway();
    try {
      const { _injectDB } = await import("../src/core/db.js");
      _injectDB(freshDB());

      const { _injectBalances } = await import("../src/integrations/helius.js");
      _injectBalances({ sol: 10.0, usd: 300, tokens: [] });

      const { _injectPositionsCache } = await import("../src/integrations/meteora/positions.js");
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      const { _injectDiscovery } = await import("../src/screening/discovery.js");
      _injectDiscovery({ pools: [] });

      const { _injectDailyPnL, _injectCircuitBreaker } = await import("../src/core/daily-tracker.js");
      _injectDailyPnL({ realized: 0, unrealized: 0 });
      _injectCircuitBreaker({ action: "trade", reason: "normal" });

      const stateMod = await import("../src/core/state/scheduler-state.js");
      const _busyState = stateMod._busyState;

      const cyclesMod = await import("../src/core/cycles.js");
      const runScreeningCycle = cyclesMod.runScreeningCycle;

      await runScreeningCycle({ silent: true });

      assert.strictEqual(_busyState._screeningBusy, false, "_screeningBusy should be false after cycle completes");
      assert.strictEqual(_busyState._managementBusy, false, "_managementBusy should be false after cycle completes");
    } finally {
      const { _busyState } = await import("../src/core/state/scheduler-state.js");
      _busyState._screeningBusy = false;
      _busyState._managementBusy = false;
      await restoreAgentGateway(originalGateway);
    }
  });

  test("concurrent getMyPositions() calls share the same promise (inflight dedup)", async () => {
    const originalPool = await injectFakeWallet();
    const originalFetch = globalThis.fetch;
    try {
      const { _injectDB } = await import("../src/core/db.js");
      _injectDB(freshDB());

      const { _injectBalances } = await import("../src/integrations/helius.js");
      _injectBalances({ sol: 10.0, usd: 300, tokens: [] });

      const { _injectPositionsCache, _resetPositionsCache } = await import("../src/integrations/meteora/positions.js");
      _injectPositionsCache(null);
      _resetPositionsCache();

      let fetchCount = 0;
      globalThis.fetch = async function mockFetch(url) {
        if (url && typeof url === "string" && url.includes("dlmm.datapi.meteora.ag")) {
          fetchCount++;
          return { ok: true, json: async () => ({ pools: [] }) };
        }
        return originalFetch?.call(this, url);
      };

      const { getMyPositions } = await import("../src/integrations/meteora.js");

      const [result1, result2] = await Promise.all([
        getMyPositions({ force: true }),
        getMyPositions({ force: true }),
      ]);

      assert.strictEqual(result1, result2, "concurrent calls should return the same promise object");
      assert.ok(fetchCount <= 1, "fetch should be called at most once, was called " + fetchCount + " time(s)");
      assert.ok(result1 && typeof result1 === "object", "result should be an object");
      assert.ok(Array.isArray(result1.positions), "result.positions should be an array");
    } finally {
      globalThis.fetch = originalFetch;
      await restorePool(originalPool);
    }
  });
});
