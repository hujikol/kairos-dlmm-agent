import { config } from "../../config.js";
import { addrShort } from "../../tools/addrShort.js";
import { log } from "../../core/logger.js";
import { normalizeMint } from "../helius/normalize.js";
import { getWallet } from "./pool.js";

// ─── Fetch DLMM PnL API for all positions in a pool ────────────

// PNL API timeout — configurable via PNL_TIMEOUT_MS env var (default 8000ms)
const PNL_TIMEOUT_MS = parseInt(process.env.PNL_TIMEOUT_MS || "8000", 10);

/**
 * Fetch raw PnL data from Meteora DLMM API for all positions in a pool for a wallet.
 * @param {string} poolAddress
 * @param {string} walletAddress
 * @returns {Promise<Object>} Map of positionAddress -> pnl entry
 */
export async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `${process.env.METEORA_DLMM_API_BASE || "https://dlmm.datapi.meteora.ag"}/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PNL_TIMEOUT_MS);
  const byAddress = {};
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("info", "pnl_api", `HTTP ${res.status} for pool ${addrShort(poolAddress)}: ${body.slice(0, 120)}`);
      return byAddress;
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("info", "pnl_api", `No positions returned for pool ${addrShort(poolAddress)} — keys: ${Object.keys(data).join(", ")}`);
    }
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("info", "pnl_api", `Fetch error for pool ${addrShort(poolAddress)}: ${e.message}`);
    return byAddress;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get real-time PnL and position metrics for a single open Meteora DLMM position via Meteora PnL API.
 * @param {Object} opts - Parameters
 * @param {string} opts.pool_address - Pool address
 * @param {string} opts.position_address - Position address
 * @returns {Promise<Object>} { pnl_usd, pnl_pct, current_value_usd, unclaimed_fee_usd, all_time_fees_usd, fee_per_tvl_24h, in_range, lower_bin, upper_bin, active_bin, age_minutes } or { error }
 */
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    return {
      pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("error", "pnl", error.message);
    return { error: error.message };
  }
}
