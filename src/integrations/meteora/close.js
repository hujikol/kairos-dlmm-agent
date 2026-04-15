import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { CLAIM_DEDUP_MS, METEORA_CLOSE_SYNC_WAIT_MS, METEORA_CLOSE_RETRY_DELAY_MS } from "../../core/constants.js";
import { recordClaim, recordClose, getTrackedPosition } from "../../core/state/registry.js";
import { recordPerformance } from "../../core/lessons.js";
import { config, isDryRun } from "../../config.js";
import { addrShort } from "../../tools/addrShort.js";
import { log } from "../../core/logger.js";
import { normalizeMint } from "../helius/normalize.js";
import { getPool, getWallet, sendTx, lookupPoolForPosition } from "./pool.js";
import { fetchDlmmPnlForPool } from "./pnl.js";
import { getMyPositions, invalidatePositionsCache } from "./positions.js";
import { positionsCache, poolCache } from "../../core/cache-manager.js";

// ─── claimFees ────────────────────────────────────────────────────

/**
 * Claim swap fees for a single open Meteora DLMM position.
 * @param {Object} opts - Parameters
 * @param {string} opts.position_address - On-chain position address
 * @returns {Promise<Object>} { success, position, txs, base_mint, quote_mint } or { success: false, error }
 */
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (isDryRun()) {
    recordClaim(position_address, 0);
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("info", "claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendTx(tx, [wallet]);
      txHashes.push(txHash);
    }
    log("info", "claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    invalidatePositionsCache();

    let claimedFeesUsd = null;
    try {
      const walletAddr = wallet.publicKey.toString();
      const pnlData = await fetchDlmmPnlForPool(poolAddress.toString(), walletAddr);
      const entry = pnlData[position_address];
      if (entry) {
        claimedFeesUsd = parseFloat(entry.allTimeFees?.total?.usd || 0);
      }
    } catch (_) { log("warn", "claim", `Non-critical error fetching claimed fees: ${_?.message || _}`); }
    if (claimedFeesUsd !== null) {
      recordClaim(position_address, claimedFeesUsd);
    }

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString(), quote_mint: pool.lbPair.tokenYMint.toString() };
  } catch (error) {
    log("error", "claim", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Phases ─────────────────────────────────────────────────

/**
 * Phase 1 of closePosition: claim accumulated fees.
 * @param {Object} ctx - CloseContext with { pool, positionPubKey, wallet, tracked, poolAddress, position_address }
 * @returns {Promise<{claimTxHashes: string[]}>}
 */
async function closeClaimFees(ctx) {
  const { pool, positionPubKey, wallet, tracked, poolAddress, position_address } = ctx;
  const claimTxHashes = [];
  const recentlyClaimed = tracked?.last_claim_at &&
    (Date.now() - new Date(tracked.last_claim_at).getTime()) < CLAIM_DEDUP_MS;

  try {
    if (recentlyClaimed) {
      log("info", "close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
    } else {
      log("info", "close", `Step 1: Claiming fees for ${position_address}`);
      const positionData = await pool.getPosition(positionPubKey);
      const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
      if (claimTxs && claimTxs.length > 0) {
        for (const tx of claimTxs) {
          const claimHash = await sendTx(tx, [wallet]);
          claimTxHashes.push(claimHash);
        }
        log("info", "close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        try {
          const walletAddr = wallet.publicKey.toString();
          const pnlData = await fetchDlmmPnlForPool(poolAddress.toString(), walletAddr);
          const entry = pnlData[position_address];
          if (entry) {
            const claimedFeesUsd = parseFloat(entry.allTimeFees?.total?.usd || 0);
            if (claimedFeesUsd > 0) recordClaim(position_address, claimedFeesUsd);
          }
        } catch (_) { log("warn", "close", `Non-critical error fetching claimed fees in close flow: ${_?.message || _}`); }
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes("nothing to claim") || msg.includes("no fees") || msg.includes("empty")) {
      log("warn", "close", `Step 1 (Claim): nothing to claim — ${msg}`);
    } else {
      log("error", "close", `Step 1 (Claim) failed — ${msg}`);
      throw e;
    }
  }
  return { claimTxHashes };
}

/**
 * Phase 2 of closePosition: remove liquidity and close the DLMM position.
 * @param {Object} ctx - CloseContext with { pool, positionPubKey, wallet }
 * @returns {Promise<{closeTxHashes: string[]}>}
 */
async function closeRemoveLiquidity(ctx) {
  const { pool, positionPubKey, wallet } = ctx;
  const closeTxHashes = [];
  let hasLiquidity = false;
  // The minimum/maximum bin ID for Meteora DLMM pools.
  // 887272 ≈ log_base(1.0001)(MAX_TICK), the theoretical max bin for tick spacing 0.0001.
  const MIN_BIN_ID = -887272;
  const MAX_BIN_ID =  887272;
  let closeFromBinId = MIN_BIN_ID;
  let closeToBinId = MAX_BIN_ID;

  try {
    const positionDataForClose = await pool.getPosition(positionPubKey);
    const processed = positionDataForClose?.positionData;
    if (processed) {
      closeFromBinId = processed.lowerBinId ?? closeFromBinId;
      closeToBinId = processed.upperBinId ?? closeToBinId;
      const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
      hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
    }
  } catch (e) {
    log("warn", "close", `Could not check liquidity state: ${e.message}`);
  }

  if (hasLiquidity) {
    log("info", "close", `Step 2: Removing liquidity and closing account`);
    const closeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: closeFromBinId,
      toBinId: closeToBinId,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });
    for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
      const txHash = await sendTx(tx, [wallet]);
      closeTxHashes.push(txHash);
    }
  } else {
    log("info", "close", `Step 2: No position liquidity detected, closing account`);
    const closeTx = await pool.closePosition({ owner: wallet.publicKey, position: { publicKey: positionPubKey } });
    const txHash = await sendTx(closeTx, [wallet]);
    closeTxHashes.push(txHash);
  }
  return { closeTxHashes };
}

/**
 * Phase 3 of closePosition: verify close succeeded and record to DB.
 * @param {Object} ctx - CloseContext
 * @param {Object} phaseResults - { claimTxHashes, closeTxHashes }
 * @param {string} reason - Close reason
 * @returns {Promise<{closedConfirmed: boolean, result: Object}>}
 */
async function closeVerifyAndRecord(ctx, phaseResults, reason) {
  const { position_address, poolAddress, tracked, wallet, pool } = ctx;
  const { claimTxHashes, closeTxHashes } = phaseResults;
  const txHashes = [...claimTxHashes, ...closeTxHashes];

  log("info", "close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
  log("info", "close", `SUCCESS txs: ${txHashes.join(", ")}`);

  await new Promise(r => setTimeout(r, METEORA_CLOSE_SYNC_WAIT_MS));
  invalidatePositionsCache();

  let closedConfirmed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const refreshed = await getMyPositions({ force: true, silent: true });
      const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
      if (!stillOpen) { closedConfirmed = true; break; }
      log("warn", "close", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
    } catch (e) {
      log("warn", "close", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, METEORA_CLOSE_RETRY_DELAY_MS));
  }

  if (!closedConfirmed) {
    return {
      closedConfirmed: false,
      result: {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address, pool: poolAddress,
        claim_txs: claimTxHashes, close_txs: closeTxHashes, txs: txHashes,
      },
    };
  }

  recordClose(position_address, reason || "agent decision");

  if (!tracked) {
    return {
      closedConfirmed: true,
      result: {
        success: true, position: position_address, pool: poolAddress, pool_name: null,
        claim_txs: claimTxHashes, close_txs: closeTxHashes, txs: txHashes,
        base_mint: pool.lbPair.tokenXMint.toString(),
        quote_mint: pool.lbPair.tokenYMint.toString(),
      },
    };
  }

  // ─── Record performance for learning ───────────────────────────
  const deployedAt = new Date(tracked.deployed_at).getTime();
  const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
  let minutesOOR = 0;
  if (tracked.out_of_range_since) {
    minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
  }

  let pnlUsd = 0, pnlPct = 0, finalValueUsd = 0, initialUsd = 0;
  let feesUsd = tracked.total_fees_claimed_usd || 0;
  try {
    const closedUrl = `${process.env.METEORA_DLMM_API_BASE || "https://dlmm.datapi.meteora.ag"}/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
    const res = await fetch(closedUrl);
    if (res.ok) {
      const data = await res.json();
      const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
      if (posEntry) {
        pnlUsd        = parseFloat(posEntry.pnlUsd || 0);
        pnlPct        = parseFloat(posEntry.pnlPctChange || 0);
        finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
        initialUsd    = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
        feesUsd       = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
        log("info", "close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`);
      } else {
        log("warn", "close", `Position not found in status=closed response — may still be settling`);
      }
    }
  } catch (e) {
    log("warn", "close", `Closed PnL fetch failed: ${e.message}`);
  }

  if (finalValueUsd === 0) {
    const cachedPos = positionsCache.get("positions")?.positions?.find(p => p.position === position_address);
    if (cachedPos) {
      pnlUsd     = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? 0;
      pnlPct     = cachedPos.pnl_pct   ?? 0;
      feesUsd    = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
      initialUsd = tracked.initial_value_usd || 0;
      if (initialUsd > 0) {
        finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
        pnlPct = (pnlUsd / initialUsd) * 100;
      } else {
        finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
        initialUsd   = Math.max(0, finalValueUsd + feesUsd - pnlUsd);
      }
      log("warn", "close", `Using cached pnl fallback because closed API has not settled yet`);
    }
  }

  await recordPerformance({
    position: position_address, pool: poolAddress,
    pool_name: tracked.pool_name || addrShort(poolAddress),
    strategy: tracked.strategy, bin_range: tracked.bin_range,
    bin_step: tracked.bin_step || null, volatility: tracked.volatility || null,
    fee_tvl_ratio: tracked.fee_tvl_ratio || null, organic_score: tracked.organic_score || null,
    amount_sol: tracked.amount_sol, fees_earned_usd: feesUsd,
    final_value_usd: finalValueUsd, initial_value_usd: initialUsd,
    minutes_in_range: minutesHeld - minutesOOR, minutes_held: minutesHeld,
    close_reason: reason || "agent decision",
    signal_snapshot: tracked.signal_snapshot || null,
    base_mint: tracked.base_mint || pool.lbPair.tokenXMint.toString(),
    deployed_at: tracked.deployed_at || null,
  });

  return {
    closedConfirmed: true,
    result: {
      success: true, position: position_address, pool: poolAddress,
      pool_name: tracked.pool_name || null,
      claim_txs: claimTxHashes, close_txs: closeTxHashes, txs: txHashes,
      pnl_usd: pnlUsd, pnl_pct: pnlPct,
      base_mint: pool.lbPair.tokenXMint.toString(),
      quote_mint: pool.lbPair.tokenYMint.toString(),
    },
  };
}

// ─── closePosition ─────────────────────────────────────────────────

/**
 * Close a Meteora DLMM position: claim remaining fees, remove liquidity, close the account.
 * Records performance to lessons.js, auto-swaps base token to SOL if configured,
 * and sends Telegram notification.
 * @param {Object} opts - Parameters
 * @param {string} opts.position_address - On-chain position address
 * @param {string} [opts.reason] - Human-readable close reason (for learning/audit)
 * @returns {Promise<Object>} { success, position, pool, claim_txs, close_txs, txs } or { success: false, error }
 */
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  const tracked = getTrackedPosition(position_address);

  if (isDryRun()) {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("info", "close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);

    const ctx = { position_address, poolAddress, tracked, wallet, pool, positionPubKey };

    // Phase 1: Claim fees
    const { claimTxHashes } = await closeClaimFees(ctx);

    // Phase 2: Remove liquidity & close
    const { closeTxHashes } = await closeRemoveLiquidity(ctx);

    // Phase 3: Verify & record
    const { closedConfirmed, result } = await closeVerifyAndRecord(
      ctx, { claimTxHashes, closeTxHashes }, reason,
    );

    return result;
  } catch (error) {
    log("error", "close", error.message);
    return { success: false, error: error.message };
  }
}
