import { Keypair, PublicKey } from "@solana/web3.js";
import { agentMeridianPositions } from "../../tools/agent-meridian.js";
import BN from "bn.js";
import {
  trackPosition,
  updatePositionStatus,
  markOutOfRange,
  markInRange,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../../core/state/index.js";
import { config, isDryRun } from "../../config.js";
import { addrShort } from "../../tools/addrShort.js";
import { log } from "../../core/logger.js";
import { isPoolOnCooldown } from "../../features/pool-memory.js";
import { normalizeMint } from "../helius/normalize.js";
import {
  getConnection,
  getWallet,
  getPool,
  getDLMM,
  DLMM_PROGRAM,
  applyPriorityFee,
  sendTx,
} from "./pool.js";
import { fetchDlmmPnlForPool } from "./pnl.js";
import { METEORA_POSITIONS_CACHE_TTL_MS } from "../../core/constants.js";

// ─── Constants ───────────────────────────────────────────────────
/** Default slippage in basis points (10 bps = 0.1%) */
const DEFAULT_SLIPPAGE_BPS = 10;
import { positionsCache } from "../../core/cache-manager.js";
import { roundTo } from "../../utils/round.js";

// ─── Positions cache ──────────────────────────────────────────────
export const POSITIONS_CACHE_TTL = METEORA_POSITIONS_CACHE_TTL_MS;

export function invalidatePositionsCache() {
  positionsCache.delete("positions");
}

// ─── Test injection ────────────────────────────────────────────────

export function _injectPositionsCache(result) {
  if (result) {
    positionsCache.setForTesting("positions", result);
  } else {
    positionsCache.delete("positions");
  }
}

export function _resetPositionsCache() {
  positionsCache.clearForTesting("positions");
  positionsCache.delete("positions");
}

// ─── deployPosition ───────────────────────────────────────────────

/**
 * Deploy a new liquidity position into a Meteora DLMM pool.
 * Handles wide-range positions (>69 bins) via multi-transaction chunking.
 * Records the position in SQLite state and transitions it from pending to active.
 * @param {Object} opts - Deploy parameters
 * @param {string} opts.pool_address - Meteora pool address
 * @param {number} [opts.amount_sol] - SOL amount (used as amount_y if amount_y not set)
 * @param {number} [opts.amount_x] - Token-X amount for two-sided positions
 * @param {number} [opts.amount_y] - Token-Y (SOL) amount
 * @param {string} [opts.strategy] - "spot"|"curve"|"bid_ask" (default from config)
 * @param {number} [opts.bins_below] - Bins below active bin (default from config)
 * @param {number} [opts.bins_above] - Bins above active bin (default 0)
 * @param {string} [opts.pool_name] - Human-readable pool name (for learning)
 * @param {number} [opts.bin_step] - Pool bin step (for learning)
 * @param {number} [opts.base_fee] - Pool base fee (for learning)
 * @param {string} [opts.base_mint] - Base token mint (for learning)
 * @param {number} [opts.volatility] - Pool volatility (for learning)
 * @param {number} [opts.fee_tvl_ratio] - Fee/TVL ratio (for learning)
 * @param {number} [opts.organic_score] - Organic score (for learning)
 * @param {number} [opts.initial_value_usd] - Initial USD value (for learning)
 * @param {string} [opts.market_phase] - Market phase at deploy (for learning)
 * @param {string} [opts.strategy_id] - Strategy identifier (for learning)
 * @returns {Promise<Object>} { success, position, pool, bin_range, price_range, bin_step, base_fee, strategy, wide_range, txs } or { success: false, error }
 */
export async function deployPosition({
  pool_address,
  amount_sol,
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  pool_name,
  bin_step,
  base_fee,
  base_mint,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  market_phase,
  strategy_id,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;

  const activeBinsBelow = Number(bins_below ?? config.strategy.binsBelow);
  const activeBinsAbove = Number(bins_above ?? 0);

  if (isPoolOnCooldown(pool_address)) {
    log("debug", "deploy", `Pool ${addrShort(pool_address)} is on cooldown (closed for low yield) — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed for low yield. Try a different pool." };
  }

  if (isDryRun()) {
    const totalBins = activeBinsBelow + activeBinsAbove;
    const finalAmountY = amount_y ?? amount_sol ?? 0;
    const finalAmountX = amount_x ?? 0;
    const fakePosition = "dry_" + addrShort(pool_address) + "_" + Date.now();
    trackPosition({
      position: fakePosition,
      pool: pool_address,
      pool_name,
      strategy: activeStrategy || "Unknown",
      bin_range: { lower: activeBinsBelow, upper: activeBinsAbove },
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: null,
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      initial_value_usd,
      base_mint,
      market_phase,
      strategy_id,
    });
    updatePositionStatus(fakePosition, "active");
    return {
      dry_run: true,
      position: fakePosition,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRange = totalBins > 69;
  const newPosition = Keypair.generate();

  log("debug", "deploy", `Pool: ${pool_address}`);
  log("debug", "deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("debug", "deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("debug", "deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendTx(createTxArray[i], signers);
        txHashes.push(txHash);
        log("info", "deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendTx(addTxArray[i], [wallet]);
        txHashes.push(txHash);
        log("info", "deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: parseInt(process.env.METEORA_SLIPPAGE_BPS || "1000"),
      });
      const txHash = await sendTx(tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    log("info", "deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    positionsCache.delete("positions");
    const newPositionKey = newPosition.publicKey.toString();
    trackPosition({
      position: newPositionKey,
      pool: pool_address,
      pool_name,
      strategy: activeStrategy || "Unknown",
      bin_range: { lower: activeBinsBelow, upper: activeBinsAbove },
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      initial_value_usd,
      base_mint,
      market_phase,
      strategy_id,
    });
    updatePositionStatus(newPositionKey, "active");

    const actualBinStep = pool.lbPair.binStep;
    const activePrice = parseFloat(activeBin.price);
    const minPrice = activePrice * Math.pow(1 + actualBinStep / 10000, minBinId - activeBin.binId);
    const maxPrice = activePrice * Math.pow(1 + actualBinStep / 10000, maxBinId - activeBin.binId);

    const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
    const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error) {
    log("error", "deploy", error.message);
    let logs = null;
    if (error.logs) {
        logs = typeof error.getLogs === 'function' ? error.getLogs() : error.logs;
        log("error", "deploy", "Program logs", { logs });
    }
    return { success: false, error: error.message, logs };
  }
}

// ─── getMyPositions helpers ───────────────────────────────────────

/**
 * _fetchPositionsFromMeteora — cache check, Meteora portfolio API call,
 * and Agent Meridian relay fallback.
 * @param {Object} ctx - Orchestrator context { force, silent }
 * @param {string} ctx.walletAddress - Solana wallet address
 * @param {boolean} ctx.force - Bypass cache
 * @param {boolean} ctx.silent - Suppress logging
 * @returns {Promise<{ pools: Array, walletAddress: string }>}
 */
async function _fetchPositionsFromMeteora({ walletAddress, force, silent }) {
  let pools = [];

  // 1. Try Meteora portfolio API first (fastest, freshest on-chain data)
  if (!silent) log("debug", "positions", "Fetching portfolio via Meteora portfolio API...");
  try {
    const portfolioUrl = `${process.env.METEORA_DLMM_API_BASE || "https://dlmm.datapi.meteora.ag"}/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (res.ok) {
      const portfolio = await res.json();
      pools = portfolio.pools || [];
      log("debug", "positions", `Meteora returned ${pools.length} pool(s) with open positions`);
    } else {
      log("warn", "positions", `Meteora portfolio API ${res.status}`);
    }
  } catch (e) {
    log("warn", "positions", `Meteora portfolio fetch failed: ${e.message}`);
  }

  // 2. Supplement with Agent Meridian relay if Meteora returned nothing
  // (relay provides richer data like outOfRange flags but has additional lag)
  if (pools.length === 0) {
    if (!silent) log("info", "positions", "Trying Agent Meridian relay for open positions...");
    try {
      const relayPositions = await agentMeridianPositions(walletAddress);
      if (relayPositions && relayPositions.length > 0) {
        pools = relayPositions.map(p => ({
          poolAddress: p.pool || p.poolAddress,
          listPositions: [p.position || p.positionAddress],
          outOfRange: p.isOutOfRange || false,
        }));
        log("info", "positions", `Relay returned ${pools.length} pool(s) with open positions`);
      }
    } catch (e) {
      log("warn", "positions", `Relay fetch failed: ${e.message}`);
    }
  }

  if (pools.length === 0) {
    log("info", "positions", "No open positions found (Meteora + relay)");
  }

  return { pools, walletAddress };
}

/**
 * _enrichPositionsWithPnL — fetches PnL data per pool and builds the enriched
 * position records with all USD/PnL/bin fields.
 * @param {Array} pools - Raw pool list from _fetchPositionsFromMeteora
 * @param {Object} ctx - Orchestrator context { walletAddress, silent }
 * @returns {Promise<Array>} positions - Enriched position objects
 */
async function _enrichPositionsWithPnL(pools, { walletAddress, silent }) {
  const binDataByPool = {};
  const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
  pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });

  const positions = [];
  for (const pool of pools) {
    for (const positionAddress of (pool.listPositions || [])) {
      const tracked = getTrackedPosition(positionAddress);
      const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

      if (isOOR) markOutOfRange(positionAddress);
      else markInRange(positionAddress);

      const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
      const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
      const upperBin  = binData?.upperBinId        ?? tracked?.bin_range?.max ?? null;
      const activeBin = binData?.poolActiveBinId  ?? tracked?.bin_range?.active ?? null;

      const ageFromState = tracked?.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null;

      positions.push({
        position:           positionAddress,
        pool:                pool.poolAddress,
        pair:                tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
        base_mint:           pool.tokenXMint,
        lower_bin:           lowerBin,
        upper_bin:           upperBin,
        active_bin:          activeBin,
        in_range:            !isOOR,
        unclaimed_fees_usd: roundTo(parseFloat(binData
          ? config.management.solMode
            ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
            : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
          : parseFloat(config.management.solMode ? (pool.unclaimedFeesSol || 0) : (pool.unclaimedFees || 0))), 4),
        total_value_usd:    roundTo(parseFloat(binData
          ? config.management.solMode
            ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
            : parseFloat(binData.unrealizedPnl?.balances || 0)
          : parseFloat(config.management.solMode ? (pool.balancesSol || 0) : (pool.balances || 0))), 4),
        total_value_true_usd: roundTo(parseFloat(binData
          ? parseFloat(binData.unrealizedPnl?.balances || 0)
          : parseFloat(pool.balances || 0)), 4),
        collected_fees_usd: roundTo(parseFloat(config.management.solMode ? (binData?.allTimeFees?.total?.sol || 0) : (binData?.allTimeFees?.total?.usd || 0)), 4),
        collected_fees_true_usd: roundTo(parseFloat(binData?.allTimeFees?.total?.usd || 0), 4),
        pnl_usd:            roundTo(parseFloat(binData
          ? config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)
          : config.management.solMode ? (pool.pnlSol || 0) : (pool.pnl || 0)), 4),
        pnl_true_usd:       roundTo(parseFloat(binData?.pnlUsd || 0), 4),
        pnl_pct:            roundTo(parseFloat(binData
          ? config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0)
          : config.management.solMode ? (pool.pnlSolPctChange || 0) : (pool.pnlPctChange || 0)), 2),
        unclaimed_fees_true_usd: roundTo(parseFloat(binData
          ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
          : parseFloat(pool.unclaimedFees || 0)), 4),
        fee_per_tvl_24h:    roundTo(parseFloat(binData?.feePerTvl24h || pool.feePerTvl24h || 0), 2),
        age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
        minutes_out_of_range: minutesOutOfRange(positionAddress),
        instruction:        tracked?.instruction ?? null,
      });
    }
  }

  return positions;
}

/**
 * _syncPositionsWithState — reconciles open positions with local SQLite state
 * (auto-closes missing positions after grace period) and writes to cache.
 * @param {Array} positions - Enriched positions from _enrichPositionsWithPnL
 * @param {Object} ctx - Orchestrator context { walletAddress }
 * @returns {Promise<Object>} Final result object { wallet, total_positions, positions }
 */
async function _syncPositionsWithState(positions, { walletAddress }) {
  await syncOpenPositions(positions.map(p => p.position));
  const result = { wallet: walletAddress, total_positions: positions.length, positions };
  positionsCache.set("positions", result, METEORA_POSITIONS_CACHE_TTL_MS);
  return result;
}

// ─── getMyPositions ─────────────────────────────────────────────────

/**
 * Get all open Meteora DLMM positions for the configured wallet.
 * Uses a 5-minute cache by default; pass force=true to bypass.
 * Syncs open positions with local SQLite state (auto-closes missing positions after grace period).
 * @param {Object} [opts={}] - Options
 * @param {boolean} [opts.force=false] - Bypass cache and fetch fresh from Meteora API
 * @param {boolean} [opts.silent=false] - Suppress verbose logging
 * @returns {Promise<Object>} { wallet, total_positions, positions: [{ position, pool, pair, base_mint, lower_bin, upper_bin, active_bin, in_range, unclaimed_fees_usd, total_value_usd, pnl_usd, pnl_pct, fee_per_tvl_24h, age_minutes, minutes_out_of_range, instruction }, ...] }
 */
export async function getMyPositions({ force = false, silent = false } = {}) {
  // Test injection check — setForTesting uses Infinity expiry so always takes precedence
  const testOverride = positionsCache.get("positions");
  if (testOverride !== undefined) {
    return Promise.resolve(testOverride);
  }

  // Cache check (skip if force=true)
  if (!force) {
    const cached = positionsCache.get("positions");
    if (cached !== undefined) {
      return cached;
    }
  }

  let inflight = null;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch (e) {
    log("warn", "meteora", `Failed to get positions: ${e?.message}`);
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  if (inflight) return inflight;

  const ctx = { walletAddress, force, silent };

  inflight = (async () => { try {
    // Step 1: fetch raw pools from Meteora API / relay fallback
    const { pools } = await _fetchPositionsFromMeteora(ctx);

    // Step 2: enrich with PnL data and build position records
    const positions = await _enrichPositionsWithPnL(pools, ctx);

    // Step 3: sync with local SQLite state and cache result
    return await _syncPositionsWithState(positions, ctx);
  } catch (error) {
    log("error", "positions", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    inflight = null;
  }
  })();
  return inflight;
}

// ─── getWalletPositions ────────────────────────────────────────────

/**
 * Get all DLMM positions for any wallet address (not just the configured one).
 * Uses program account scan with manual PnL enrichment.
 * @param {Object} opts - Parameters
 * @param {string} opts.wallet_address - Wallet public key string
 * @returns {Promise<Object>} { wallet, total_positions, positions: [{ position, pool, lower_bin, upper_bin, active_bin, in_range, unclaimed_fees_usd, total_value_usd, pnl_usd, pnl_pct, age_minutes }, ...] }
 */
export async function getWalletPositions({ wallet_address }) {
  try {
    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:                r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("error", "wallet_positions", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}
