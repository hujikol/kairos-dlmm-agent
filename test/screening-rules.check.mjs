import "./setup-env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { _injectDB, closeDB, migrate } from "../src/core/db.js";

test("screening executes three distinct deterministic winners, uses 24h volume and finalizes zero-LLM cycle", async () => {
  const stub = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });
  const db = new Database(":memory:"); migrate(db); _injectDB(db);
  const pool = { pool: "A", name: "A/SOL", base: { mint: "TokenA" }, quote: { mint: "So11111111111111111111111111111111111111112" }, organic_score: 80,
    volatility: 1, fee_active_tvl_ratio: 0.2, fee_pct: 1, active_tvl: 10000, token_age_hours: 48 };
  const pools = [pool, { ...pool, pool: "B", name: "B/SOL", base: { mint: "TokenB" } },
    { ...pool, pool: "C", name: "C/SOL", base: { mint: "TokenC" } },
    { ...pool, pool: "D", name: "D/SOL", base: { mint: "TokenA" } }];
  const before = { total_positions: 0, positions: [] };
  const after = { total_positions: 3, positions: [{ position: "new-A", pool: "A" }, { position: "new-B", pool: "B" }, { position: "new-C", pool: "C" }] };
  let reads = 0;
  stub("../src/integrations/meteora.js", { getMyPositions: async () => ++reads === 1 ? before : after, getActiveBin: async () => ({ binId: 42 }) });
  stub("../src/integrations/helius.js", { getWalletBalances: async () => ({ sol: 10, sol_price: 100, total_usd: 1000 }) });
  stub("../src/screening/discovery.js", { getTopCandidates: async () => ({ candidates: pools }),
    getPoolDetail: async ({ timeframe, pool_address }) => { assert.equal(timeframe, "24h"); return { pool_address, volume: 100000 }; } });
  stub("../src/core/screening-helpers.js", { fetchAndReconCandidates: async p => p.map(pool => ({ pool })), applyHardFilters: c => c });
  stub("../src/core/toxic-pool-filter.js", { isToxicPool: () => false });
  stub("../src/features/pool-memory.js", { getPoolMemory: () => ({ known: false }), isPoolOnCooldown: () => false });
  stub("../src/core/daily-tracker.js", { checkDailyCircuitBreaker: async () => ({ action: "trade" }) });
  stub("../src/notifications/telegram.js", { isEnabled: () => false, sendHTML() {}, drainTelegramQueue() {} });
  stub("../src/core/logger.js", { log() {} });
  let deploys = 0;
  stub("../src/tools/executor.js", { executeTool: async (name, args) => {
    deploys++; assert.equal(name, "deploy_position"); assert.ok(["A", "B", "C"].includes(args.pool_address), "one position per token");
    assert.equal(args.conviction, "normal"); assert.equal(args.bins_above, 0);
    return { success: true, position: `new-${args.pool_address}` };
  } });
  const previous = process.env.DRY_RUN; process.env.DRY_RUN = "false";
  try {
    const { runScreeningCycle } = await import("../src/core/screening-cycle.js");
    assert.match(await runScreeningCycle({ silent: true }), /DEPLOY EXECUTED/);
    assert.equal(deploys, 3);
    const row = db.prepare("SELECT * FROM cycle_outcomes").get();
    assert.equal(row.llm_calls, 0); assert.equal(row.deploy_confirmed, 1); assert.ok(row.finalized_at);
    assert.equal(db.prepare("SELECT rejection_reason FROM rejected_candidates").get().rejection_reason, "selected_by_rules");
    const { _busyState } = await import("../src/core/state/scheduler-state.js");
    assert.equal(_busyState._screeningBusy, false);
  } finally {
    if (previous === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = previous;
    mock.restoreAll(); closeDB();
  }
});
