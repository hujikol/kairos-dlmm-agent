import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _injectDB, closeDB, migrate } from "../src/core/db.js";

test("dry-run integration spends DB money, settles once, persists learning and never signs", async () => {
  process.env.DRY_RUN = "true";
  process.env.RPC_URL = "http://127.0.0.1:1";
  delete process.env.WALLET_PRIVATE_KEY;
  process.env.KAIROS_PAPER_SOL_PRICE_USD = "100";
  process.env.KAIROS_PAPER_START_SOL = "10";
  const dir = mkdtempSync(join(tmpdir(), "kairos-paper-"));
  const path = join(dir, "paper.db");
  let db = new Database(path);
  migrate(db);
  _injectDB(db);
  const { config } = await import("../src/config.js");
  const { _injectPool, sendTx } = await import("../src/integrations/meteora/pool.js");
  _injectPool({ getActiveBin: async () => ({ binId: 100, price: "2" }), fromPricePerLamport: x => x });
  const pool = "TestPool";
  const network = [];
  mock.method(globalThis, "fetch", async (url, options) => {
    network.push({ url: String(url), method: options?.method || "GET" });
    assert.match(String(url), /pool_address/);
    assert.equal(options?.method || "GET", "GET", "paper mode only reads market data");
    return { ok: true, json: async () => ({ data: [{ pool_address: pool, volume: 100000, fee_pct: 1, active_tvl: 10000 }] }) };
  });
  try {
    const { getWalletBalances } = await import("../src/integrations/helius/balances.js");
    const { deployPosition, getMyPositions } = await import("../src/integrations/meteora/positions.js");
    const { claimFees, closePosition } = await import("../src/integrations/meteora/close.js");
    const { swapToken } = await import("../src/integrations/helius/swaps.js");
    const paper = await import("../src/core/paper-wallet.js");
    assert.equal((await getWalletBalances()).sol, 10);
    const args = { pool_address: pool, pool_name: "TEST/SOL", base_mint: "Token", amount_y: 0.5,
      bins_below: 10, bins_above: 0, organic_score: 70, volatility: 3, fee_tvl_ratio: 0.1 };
    const deployed = await deployPosition(args);
    assert.equal(deployed.success, true);
    assert.equal((await getWalletBalances()).sol, 9.5);
    assert.equal((await getMyPositions()).total_positions, 1);
    await assert.rejects(() => deployPosition(args), /exposure/);
    assert.equal((await getWalletBalances()).sol, 9.5, "failed duplicate cannot debit wallet");
    const p = paper.getPaperPosition(deployed.position);
    p.marked_at = Date.now() - 86_400_000;
    p.deployed_at = new Date(p.marked_at).toISOString();
    paper.savePaperPosition(p);
    assert.equal((await claimFees({ position_address: p.position })).success, true);
    assert.ok((await getWalletBalances()).sol >= 9.55 - 1e-6);
    const closed = await closePosition({ position_address: p.position, reason: "paper test" });
    assert.equal(closed.success, true);
    const settled = (await getWalletBalances()).sol;
    assert.ok(settled >= 10.05 - 1e-6 && settled < 10.051);
    assert.equal((await closePosition({ position_address: p.position })).success, false);
    assert.equal((await getWalletBalances()).sol, settled, "repeated close cannot double-credit");
    assert.equal((await getMyPositions()).total_positions, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM positions").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM performance").get().n, 0, "paper outcomes never become live performance");
    await assert.rejects(() => sendTx({}, []), /disabled/);
    const swap = await swapToken({ input_mint: config.tokens.SOL, output_mint: config.tokens.USDC, amount: 1 });
    assert.equal(swap.amount_out, 99.7);
    const swapped = (await getWalletBalances()).sol;
    closeDB();
    db = new Database(path);
    _injectDB(db);
    assert.equal((await getWalletBalances()).sol, swapped, "paper money survives restart");
    assert.equal(paper.getPaperPosition(p.position).source, "paper");
    assert.equal(paper.getPaperPosition(p.position).closed, true);
    assert.equal(paper.getPaperPoolMemory(pool).total_deploys, 1);
    assert.equal(paper.getPaperPerformanceSummary().total_positions_closed, 1);
    assert.equal(paper.getPaperPerformanceHistory().positions[0].source, "paper");
    process.env.DRY_RUN = "false";
    const { getActiveRules } = await import("../src/core/rule-memory.js");
    assert.equal(getActiveRules().minOrganic, 60, "paper activity cannot silently promote live rules");
    assert.equal((await closePosition({ position_address: p.position })).success, false);
    assert.ok(network.length > 0);
  } finally {
    mock.restoreAll();
    _injectPool(null);
    closeDB();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.KAIROS_PAPER_SOL_PRICE_USD;
  }
});

test("live bid-ask accepts active bin as inclusive upper bound using mocked transactions", async () => {
  process.env.DRY_RUN = "false";
  const { Keypair } = await import("@solana/web3.js");
  const { default: bs58 } = await import("bs58");
  process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const db = new Database(":memory:"); migrate(db); _injectDB(db);
  const { _injectPool, _injectSendTx } = await import("../src/integrations/meteora/pool.js");
  let sent = 0;
  _injectSendTx(async () => { sent++; return "mock-tx"; });
  _injectPool({ getActiveBin: async () => ({ binId: 100, price: "2" }),
    lbPair: { binStep: 100, parameters: {} },
    initializePositionAndAddLiquidityByStrategy: async ({ strategy }) => {
      assert.equal(strategy.maxBinId, 100); assert.equal(strategy.minBinId, 90); return {};
    } });
  try {
    const { deployPosition } = await import("../src/integrations/meteora/positions.js");
    const result = await deployPosition({ pool_address: "TestPool", strategy: "bid_ask", amount_y: 0.5, bins_below: 10, bins_above: 0 });
    assert.equal(result.success, true); assert.equal(sent, 1);
  } finally { _injectPool(null); _injectSendTx(null); closeDB(); }
});
