import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

test("paper positions and Telegram queues stay bounded under sustained market fixtures", {
  skip: process.env.KAIROS_SOAK_TEST !== "true", timeout: 90000,
}, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const dir = path.join(root, "logs", `paper-fixture-soak-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { DRY_RUN: "true", RPC_URL: "http://127.0.0.1:1", KAIROS_PAPER_SOL_PRICE_USD: "100",
    KAIROS_USER_CONFIG_PATH: path.join(root, "profiles/high-volume-paper.json"), KAIROS_DIAGNOSTICS: "true", KAIROS_DIAGNOSTICS_DIR: dir });
  delete process.env.WALLET_PRIVATE_KEY; delete process.env.TELEGRAM_BOT_TOKEN;
  const { _injectDB, migrate, closeDB } = await import("../src/core/db.js");
  const db = new Database(path.join(dir, "paper.db")); migrate(db); _injectDB(db);
  const pools = ["A", "B", "C"].map(pool => ({ pool, name: `${pool}/SOL`, base: { mint: `Token${pool}` },
    quote: { mint: "So11111111111111111111111111111111111111112" }, organic_score: 80, volatility: 1,
    fee_active_tvl_ratio: 0.2, fee_pct: 1, active_tvl: 50000, token_age_hours: 72, holders: 2000, bundle_pct: 5, bin_step: 20 }));
  const stub = (relative, exports) => mock.module(new URL(relative, import.meta.url).href, { exports });
  stub("../src/screening/discovery.js", { discoverPools: async () => ({ pools }), getTopCandidates: async () => ({ candidates: pools }),
    getPoolDetail: async ({ pool_address }) => ({ pool_address, volume: 500000, fee_pct: 1, active_tvl: 50000 }) });
  stub("../src/integrations/jupiter.js", { getTokenHolders: async () => ({}), getTokenNarrative: async () => ({}), getTokenInfo: async ({ query }) => ({ results: [{ mint: query, global_fees_sol: 50,
    audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 10, bot_holders_pct: 5 } }] }) });
  stub("../src/core/logger.js", { log() {}, logAction() {} });
  const { _injectPool } = await import("../src/integrations/meteora/pool.js");
  _injectPool({ getActiveBin: async () => ({ binId: 100, price: "2" }), fromPricePerLamport: x => x });
  const { runScreeningCycle } = await import("../src/core/screening-cycle.js");
  const { runManagementCycle } = await import("../src/core/management-cycle.js");
  const { telegramHandler, _telegramBusy, drainTelegramQueue } = await import("../src/telegram/index.js");
  const { _busyState } = await import("../src/core/state/scheduler-state.js");
  const { startDiagnostics, stopDiagnostics, sampleDiagnostics } = await import("../src/core/diagnostics.js");
  const paper = await import("../src/core/paper-wallet.js");
  startDiagnostics();
  const samples = [];
  let requests = 0, peakHandlers = 0;
  try {
    const initial = await runScreeningCycle({ silent: true });
    assert.equal(paper.listPaperPositions().length, 3, initial);
    global.gc?.(); const baseline = process.memoryUsage().heapUsed;
    for (let batch = 0; batch < 60; batch++) {
      const commands = Array.from({ length: 30 }, (_, i) => { requests++; return telegramHandler(i % 2 ? "/balance" : "/thresholds"); });
      peakHandlers = Math.max(peakHandlers, _telegramBusy._count);
      await Promise.all(commands);
      await new Promise(r => setImmediate(r)); drainTelegramQueue();
      if (batch % 10 === 0) {
        await runManagementCycle({ silent: true });
        global.gc?.(); samples.push(process.memoryUsage().heapUsed); sampleDiagnostics();
      }
      if (batch % 20 === 19) {
        for (const p of paper.listPaperPositions()) await paper.settlePaperPosition(p.position, true, "fixture lifecycle check");
        await runScreeningCycle({ silent: true });
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    await new Promise(r => setImmediate(r)); global.gc?.(); sampleDiagnostics();
    assert.equal(_telegramBusy._count, 0); assert.equal(_busyState._screeningBusy, false); assert.equal(_busyState._managementBusy, false);
    assert.ok(peakHandlers <= 3); assert.ok(paper.listPaperPositions().length <= 3);
    const growth = process.memoryUsage().heapUsed - baseline;
    if (global.gc) assert.ok(growth < 16 * 1024 * 1024, `retained heap growth ${growth}`);
    const report = { source: "synthetic market fixtures", durationSeconds: 60, commands: requests, peakHandlers,
      finalHandlers: _telegramBusy._count, openPositions: paper.listPaperPositions().length,
      closedPositions: paper.getPaperPerformanceSummary().total_positions_closed,
      retainedHeapGrowthMB: growth / 1048576, heapSamplesMB: samples.map(n => n / 1048576) };
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ directory: dir, ...report }));
  } finally { stopDiagnostics(); mock.restoreAll(); _injectPool(null); closeDB(); }
});
