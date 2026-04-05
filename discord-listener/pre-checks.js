/**
 * Discord signal pre-check pipeline
 * Stages: dedup → blacklist → pool resolution → rug check → deployer check → fees check
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { isBlacklisted } from "../src/features/token-blacklist.js";
import { isDevBlocked } from "../src/features/dev-blocklist.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── Shared axios instance with base URL and timeout ──────────
const api = axios.create({ timeout: 8000 });

// ─── Config cache (read once, not per-signal) ─────────────────
let _minFeesSol = null;
function getMinFeesSol() {
  if (_minFeesSol !== null) return _minFeesSol;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "user-config.json"), "utf8"));
    _minFeesSol = cfg.screening?.minTokenFeesSol ?? cfg.minTokenFeesSol ?? 30;
  } catch {
    _minFeesSol = 30;
  }
  return _minFeesSol;
}

// ─── In-memory dedup with periodic cleanup ────────────────────
const recentSeen = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
let lastDedupSweep = 0;

function sweepDedup() {
  const now = Date.now();
  if (now - lastDedupSweep < DEDUP_WINDOW_MS) return; // throttle sweeping
  for (const [k, ts] of recentSeen.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) recentSeen.delete(k);
  }
  lastDedupSweep = now;
}

export function dedupCheck(address) {
  if (recentSeen.has(address) && Date.now() - recentSeen.get(address) < DEDUP_WINDOW_MS) {
    return { pass: false, reason: "dedup: seen in last 10 minutes" };
  }
  recentSeen.set(address, Date.now());
  sweepDedup();
  return { pass: true };
}

// ─── Stage 2: Token blacklist ─────────────────────────────────
export function blacklistCheck(mint) {
  if (isBlacklisted(mint)) {
    return { pass: false, reason: "blacklisted token" };
  }
  return { pass: true };
}

// ─── Stage 3: Pool resolution (parallel) ──────────────────────
export async function resolvePool(address) {
  // Try both sources in parallel — first valid wins
  const [meteora, dexscreener] = await Promise.allSettled([
    api.get(`https://dlmm.datapi.meteora.ag/pools/${address}`),
    api.get(`https://api.dexscreener.com/latest/dex/search?q=${address}`),
  ]);

  // Route 1: Meteora direct
  if (meteora.status === "fulfilled" && meteora.value?.data) {
    const pool = meteora.value.data;
    if (pool?.address || pool?.pubkey || pool?.pool_address) {
      const poolAddr = pool.address || pool.pubkey || pool.pool_address || address;
      const baseMint = pool.mint_x || pool.base_mint || pool.token_x?.address;
      const symbol = pool.name?.split("-")[0] || pool.token_x?.symbol || "?";
      const createdAt = pool.created_at || pool.pool_created_at || pool.token_x?.created_at;
      const tokenAgeMinutes = createdAt ? Math.round((Date.now() - createdAt) / 60000) : null;
      return { pass: true, pool_address: poolAddr, base_mint: baseMint, symbol, source: "meteora_direct", token_age_minutes: tokenAgeMinutes };
    }
  }

  // Route 2: DexScreener + filter
  if (dexscreener.status === "fulfilled" && dexscreener.value?.data) {
    const pairs = dexscreener.value.data?.pairs || [];
    const meteoraPairs = pairs.filter(p =>
      p.dexId === "meteora-dlmm" &&
      (p.baseToken?.address === address || p.quoteToken?.address === address)
    );
    if (meteoraPairs.length > 0) {
      const best = meteoraPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      const pairCreated = best.pairCreatedAt ? new Date(best.pairCreatedAt).getTime() : null;
      const tokenAgeMinutes = pairCreated ? Math.round((Date.now() - pairCreated) / 60000) : null;
      return {
        pass: true,
        pool_address: best.pairAddress,
        base_mint: best.baseToken?.address,
        symbol: best.baseToken?.symbol || "?",
        source: "dexscreener",
        token_age_minutes: tokenAgeMinutes,
      };
    }
  }

  return { pass: false, reason: "no Meteora DLMM pool found for this token" };
}

// ─── Stage 4: Rug check ───────────────────────────────────────
export async function rugCheck(mint) {
  if (!mint) return { pass: true, rug_score: null };
  try {
    const res = await api.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    const data = res.data;
    if (data.rugged) return { pass: false, reason: "rugcheck: token is rugged" };
    if ((data.score || 0) > 50000) return { pass: false, reason: `rugcheck: score too high (${data.score})` };
    const top10pct = (data.topHolders || []).slice(0, 10).reduce((sum, h) => sum + (h.pct || h.percentage || 0), 0);
    if (top10pct > 60) return { pass: false, reason: `rugcheck: top10 holders ${top10pct.toFixed(1)}% > 60%` };
    return { pass: true, rug_score: data.score || 0 };
  } catch (e) {
    console.warn(`  [rugcheck] API error for ${mint}: ${e.message} — passing`);
    return { pass: true, rug_score: null };
  }
}

// ─── Stage 5: Deployer blocklist ──────────────────────────────
export async function deployerCheck(poolAddress) {
  try {
    const res = await api.get(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
    const creator = res.data?.creator || res.data?.creator_address;
    if (creator && isDevBlocked(creator)) {
      return { pass: false, reason: `deployer blocked: ${creator}` };
    }
  } catch { /* can't check, pass */ }
  return { pass: true };
}

// ─── Stage 6: Global fees check ───────────────────────────────
export async function feesCheck(mint) {
  if (!mint) return { pass: true, global_fees_sol: null };

  const minFeesSol = getMinFeesSol();

  try {
    const res = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${mint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tokens = Array.isArray(data) ? data : [data];
    const token = tokens.find(t => t.id === mint) || tokens[0];
    const globalFees = token?.fees != null ? parseFloat(token.fees) : null;

    if (globalFees === null) {
      console.warn(`  [fees] No fee data for ${mint} — passing`);
      return { pass: true, global_fees_sol: null };
    }
    if (globalFees < minFeesSol) {
      return { pass: false, reason: `global fees too low: ${globalFees.toFixed(2)} SOL < ${minFeesSol} SOL threshold` };
    }
    return { pass: true, global_fees_sol: globalFees };
  } catch (e) {
    console.warn(`  [fees] Jupiter API error: ${e.message} — passing`);
    return { pass: true, global_fees_sol: null };
  }
}

// ─── Full pipeline ────────────────────────────────────────────
export async function runPreChecks(address) {
  console.log(`\n[pre-check] ${address}`);

  const dedup = dedupCheck(address);
  if (!dedup.pass) { console.log(`  REJECT [dedup] ${dedup.reason}`); return { pass: false, ...dedup }; }
  console.log(`  OK [dedup]`);

  const bl = blacklistCheck(address);
  if (!bl.pass) { console.log(`  REJECT [blacklist] ${bl.reason}`); return { pass: false, ...bl }; }
  console.log(`  OK [blacklist]`);

  const pool = await resolvePool(address);
  if (!pool.pass) { console.log(`  REJECT [pool] ${pool.reason}`); return { pass: false, ...pool }; }
  console.log(`  OK [pool] → ${pool.pool_address} (${pool.symbol}, via ${pool.source})`);

  if (pool.base_mint && pool.base_mint !== address) {
    const bl2 = blacklistCheck(pool.base_mint);
    if (!bl2.pass) { console.log(`  REJECT [blacklist-mint] ${bl2.reason}`); return { pass: false, ...bl2 }; }
  }

  const rug = await rugCheck(pool.base_mint);
  if (!rug.pass) { console.log(`  REJECT [rug] ${rug.reason}`); return { pass: false, ...rug, ...pool }; }
  console.log(`  OK [rug] score=${rug.rug_score ?? "n/a"}`);

  const deployer = await deployerCheck(pool.pool_address);
  if (!deployer.pass) { console.log(`  REJECT [deployer] ${deployer.reason}`); return { pass: false, ...deployer, ...pool }; }
  console.log(`  OK [deployer]`);

  const fees = await feesCheck(pool.base_mint);
  if (!fees.pass) { console.log(`  REJECT [fees] ${fees.reason}`); return { pass: false, ...fees, ...pool }; }
  console.log(`  OK [fees] global_fees=${fees.global_fees_sol ?? "n/a"} SOL`);

  console.log(`  PASS → queuing signal (token age: ${pool.token_age_minutes ?? "unknown"} min)`);
  return {
    pass: true,
    pool_address: pool.pool_address,
    base_mint: pool.base_mint,
    symbol: pool.symbol,
    rug_score: rug.rug_score,
    total_fees_sol: fees.global_fees_sol,
    token_age_minutes: pool.token_age_minutes,
  };
}
