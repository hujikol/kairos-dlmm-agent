import { balanceCache } from "./cache-manager.js";
import { randomUUID } from "node:crypto";
import { getDB } from "./db.js";
import { config, isDryRun } from "../config.js";

const round = n => Math.round(n * 1e9) / 1e9;
const assertPaper = () => { if (!isDryRun()) throw new Error("Paper wallet requires DRY_RUN=true"); };

function wallet() {
  const db = getDB();
  const seed = Number(process.env.KAIROS_PAPER_START_SOL ?? 10);
  if (!Number.isFinite(seed) || seed <= 0) throw new Error("Invalid paper starting SOL");
  db.prepare("INSERT OR IGNORE INTO kv_store (key, value) VALUES ('paper_wallet', ?)")
    .run(JSON.stringify({ [config.tokens.SOL]: seed }));
  return JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = 'paper_wallet'").get().value);
}

function saveWallet(balances) {
  for (const value of Object.values(balances)) if (!Number.isFinite(value) || value < 0) throw new Error("Invalid paper balance");
  getDB().prepare("UPDATE kv_store SET value = ? WHERE key = 'paper_wallet'").run(JSON.stringify(balances));
}

export function getPaperPosition(position) {
  const row = getDB().prepare("SELECT data FROM paper_positions WHERE position = ?").get(position);
  return row ? JSON.parse(row.data) : null;
}

export function savePaperPosition(position) {
  getDB().prepare("INSERT OR REPLACE INTO paper_positions (position, closed, data) VALUES (?, ?, ?)")
    .run(position.position, position.closed ? 1 : 0, JSON.stringify(position));
}

export function listPaperPositions(openOnly = true) {
  return getDB().prepare(`SELECT data FROM paper_positions ${openOnly ? "WHERE closed = 0" : ""}`)
    .all().map(r => JSON.parse(r.data));
}

export async function paperPrices(mints) {
  const fixedSol = process.env.KAIROS_PAPER_SOL_PRICE_USD;
  if (fixedSol && mints.every(m => [config.tokens.SOL, config.tokens.USDC].includes(m))) {
    const price = Number(fixedSol);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid fixed paper SOL price");
    return Object.fromEntries(mints.map(m => [m, m === config.tokens.SOL ? price : 1]));
  }
  const cacheKey = `paper-prices:${[...mints].sort().join(",")}`;
  const cached = balanceCache.get(cacheKey);
  if (cached) return cached;
  const headers = process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
  const response = await fetch(`https://api.jup.ag/price/v3?ids=${mints.map(encodeURIComponent).join(",")}`, {
    headers, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Paper price feed HTTP ${response.status}`);
  const data = await response.json();
  const prices = Object.fromEntries(mints.map(m => {
    const price = data[m]?.usdPrice;
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Missing paper price for ${m}`);
    return [m, price];
  }));
  balanceCache.set(cacheKey, prices, 30_000);
  return prices;
}

export async function getPaperBalances() {
  assertPaper();
  const balances = wallet();
  const prices = await paperPrices(Object.keys(balances));
  const sol = balances[config.tokens.SOL] ?? 0;
  const tokens = Object.entries(balances).filter(([m]) => m !== config.tokens.SOL)
    .map(([mint, balance]) => ({ mint, balance, symbol: mint === config.tokens.USDC ? "USDC" : mint.slice(0, 6), usd: balance * prices[mint] }));
  return { wallet: "PAPER", dry_run: true, sol, sol_price: prices[config.tokens.SOL],
    sol_usd: sol * prices[config.tokens.SOL], usdc: balances[config.tokens.USDC] ?? 0, tokens,
    total_usd: sol * prices[config.tokens.SOL] + tokens.reduce((n, t) => n + t.usd, 0) };
}

export function paperMintBalance(mint) { assertPaper(); return wallet()[mint] ?? 0; }

export async function deployPaperPosition(args) {
  assertPaper();
  const amount = args.amount_y ?? args.amount_sol;
  if (!Number.isFinite(amount) || amount <= 0 || (args.amount_x ?? 0) !== 0) throw new Error("Paper deploy requires positive SOL-only amount");
  const { getActiveBin } = await import("../integrations/meteora/pool.js");
  const bin = await getActiveBin({ pool_address: args.pool_address });
  if (!Number.isInteger(bin?.binId) || !Number.isFinite(Number(bin.price)) || Number(bin.price) <= 0) throw new Error("Missing paper entry price/bin");
  const prices = await paperPrices([config.tokens.SOL]);
  const position = { ...args, position: `paper_${randomUUID()}`, pool: args.pool_address,
    pair: args.pool_name || args.pool_address, amount_sol: amount, entry_price: Number(bin.price),
    sol_price: prices[config.tokens.SOL], initial_value_usd: amount * prices[config.tokens.SOL],
    lower_bin: bin.binId - (args.bins_below ?? config.strategy.binsBelow),
    upper_bin: bin.binId + (args.bins_above ?? 0), active_bin: bin.binId,
    deployed_at: new Date().toISOString(), marked_at: Date.now(), closed: false,
    fees_earned_usd: 0, total_fees_claimed_usd: 0, unclaimed_fees_usd: 0,
    total_value_usd: amount * prices[config.tokens.SOL], pnl_usd: 0, pnl_pct: 0,
    in_range: true, minutes_out_of_range: 0, age_minutes: 0, source: "paper" };
  getDB().transaction(() => {
    const balances = wallet();
    const open = listPaperPositions();
    if (open.length >= config.risk.maxPositions || open.some(p => p.pool === position.pool || p.base_mint === position.base_mint)) throw new Error("Paper position/exposure limit");
    if ((balances[config.tokens.SOL] ?? 0) < amount + config.management.gasReserve) throw new Error("Insufficient paper SOL after gas reserve");
    balances[config.tokens.SOL] = round(balances[config.tokens.SOL] - amount);
    saveWallet(balances);
    savePaperPosition(position);
  })();
  return { success: true, dry_run: true, position: position.position, pool_name: position.pair, message: "Paper deployment; no transaction signed" };
}

export async function markPaperPosition(address) {
  assertPaper();
  const initial = getPaperPosition(address);
  if (!initial || initial.closed) throw new Error("Paper position missing or closed");
  const { getActiveBin } = await import("../integrations/meteora/pool.js");
  const { getPoolDetail } = await import("../screening/discovery.js");
  const [bin, daily, prices] = await Promise.all([
    getActiveBin({ pool_address: initial.pool }),
    getPoolDetail({ pool_address: initial.pool, timeframe: "24h" }), paperPrices([config.tokens.SOL]),
  ]);
  const price = Number(bin.price);
  if (!Number.isInteger(bin.binId) || !Number.isFinite(price) || price <= 0 ||
      daily.pool_address !== initial.pool || !Number.isFinite(daily.volume) || daily.volume < 0 ||
      !Number.isFinite(daily.fee_pct) || daily.fee_pct < 0 || !Number.isFinite(daily.active_tvl) || daily.active_tvl <= 0) throw new Error("Invalid paper market snapshot");
  // Re-read after async quotes: concurrent claims/marks must not accrue the same interval twice.
  const p = getPaperPosition(address);
  if (!p || p.closed) throw new Error("Paper position already closed");
  const now = Date.now();
  const elapsedDays = Math.max(0, now - p.marked_at) / 86_400_000;
  const inRange = bin.binId >= p.lower_bin && bin.binId <= p.upper_bin;
  // shortcut: constant-product value and pro-rata fees approximate DLMM fills; use exact bin inventory before trusting paper PnL as live evidence.
  const value = p.amount_sol * prices[config.tokens.SOL] * Math.sqrt(price / p.entry_price);
  const fees = p.in_range && inRange ? daily.volume * daily.fee_pct / 100 * (value / daily.active_tvl) * elapsedDays : 0;
  p.fees_earned_usd += fees;
  p.unclaimed_fees_usd += fees;
  p.total_value_usd = value;
  p.pnl_usd = value + p.fees_earned_usd - p.initial_value_usd;
  p.pnl_pct = p.pnl_usd / p.initial_value_usd * 100;
  p.active_bin = bin.binId;
  p.in_range = inRange;
  p.out_of_range_since = inRange ? null : p.out_of_range_since || new Date(now).toISOString();
  p.minutes_out_of_range = p.out_of_range_since ? (now - Date.parse(p.out_of_range_since)) / 60_000 : 0;
  p.age_minutes = (now - Date.parse(p.deployed_at)) / 60_000;
  p.fee_per_tvl_24h = daily.volume * daily.fee_pct / daily.active_tvl;
  p.marked_at = now;
  p.sol_price = prices[config.tokens.SOL];
  savePaperPosition(p);
  return p;
}

export async function getPaperPositions() {
  assertPaper();
  const positions = await Promise.all(listPaperPositions().map(p => markPaperPosition(p.position)));
  return { wallet: "PAPER", dry_run: true, total_positions: positions.length, positions };
}

export async function settlePaperPosition(address, close = false, reason = "paper close") {
  assertPaper();
  const existing = getPaperPosition(address);
  if (!existing || existing.closed) return { success: false, dry_run: true, already_closed: true, error: "Paper position missing or closed" };
  await markPaperPosition(address);
  const result = getDB().transaction(() => {
    const p = getPaperPosition(address);
    if (!p || p.closed) return { success: false, already_closed: true, dry_run: true };
    const balances = wallet();
    const payout = (p.unclaimed_fees_usd + (close ? p.total_value_usd : 0)) / p.sol_price;
    balances[config.tokens.SOL] = round((balances[config.tokens.SOL] ?? 0) + payout);
    p.total_fees_claimed_usd += p.unclaimed_fees_usd;
    p.unclaimed_fees_usd = 0;
    if (close) { p.closed = true; p.closed_at = new Date().toISOString(); p.close_reason = reason; }
    saveWallet(balances);
    savePaperPosition(p);
    return { success: true, dry_run: true, position: address, pool: p.pool, pool_name: p.pair, pnl_usd: p.pnl_usd, pnl_pct: p.pnl_pct, amount_out: payout };
  })();
  if (close && result.success && getDB().prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE closed = 1").get().n % 5 === 0) {
    const { updateRules } = await import("./rule-memory.js");
    updateRules().catch(() => {});
  }
  return result;
}

export async function swapPaperTokens({ input_mint, output_mint, amount }) {
  assertPaper();
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid paper swap amount");
  const prices = await paperPrices([input_mint, output_mint]);
  return getDB().transaction(() => {
    const balances = wallet();
    if ((balances[input_mint] ?? 0) < amount) throw new Error("Insufficient paper token balance");
    const received = round(amount * prices[input_mint] / prices[output_mint] * 0.997);
    balances[input_mint] = round(balances[input_mint] - amount);
    balances[output_mint] = round((balances[output_mint] ?? 0) + received);
    saveWallet(balances);
    return { success: true, dry_run: true, input_mint, output_mint, amount_in: amount, amount_out: received };
  })();
}


export function getPaperPerformanceSummary() {
  const stats = getDB().prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(json_extract(data, '$.pnl_usd')), 0) AS total_pnl,
    AVG(json_extract(data, '$.pnl_pct')) AS avg_pnl,
    AVG(CASE WHEN json_extract(data, '$.pnl_usd') > 0 THEN 100.0 ELSE 0 END) AS win_rate
    FROM paper_positions WHERE closed = 1`).get();
  return { source: "paper", total_positions_closed: stats.count, total_pnl_usd: stats.total_pnl,
    avg_pnl_pct: stats.avg_pnl, win_rate_pct: stats.win_rate, avg_range_efficiency_pct: null, total_lessons: 0 };
}

export function getPaperPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = getDB().prepare(`SELECT data FROM paper_positions WHERE closed = 1
    AND json_extract(data, '$.closed_at') >= ? ORDER BY json_extract(data, '$.closed_at') DESC LIMIT ?`).all(cutoff, limit);
  const positions = rows.map(r => JSON.parse(r.data));
  return { source: "paper", hours, count: positions.length,
    total_pnl_usd: positions.reduce((n, p) => n + p.pnl_usd, 0),
    win_rate_pct: positions.length ? positions.filter(p => p.pnl_usd > 0).length / positions.length * 100 : null, positions };
}


export function getPaperPoolMemory(pool) {
  const summary = getDB().prepare(`SELECT COUNT(*) AS total_deploys,
    AVG(CASE WHEN json_extract(data, '$.pnl_usd') > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
    AVG(json_extract(data, '$.pnl_pct')) AS avg_pnl_pct FROM paper_positions
    WHERE closed = 1 AND json_extract(data, '$.pool') = ?`).get(pool);
  return { source: "paper", ...summary };
}
