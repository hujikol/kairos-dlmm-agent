/**
 * PnL exit signal detection — updatePnlAndCheckExits.
 *
 * This module is importable and testable standalone.
 * OOR state is READ-ONLY — writes go through markOutOfRange / markInRange
 * from ./oor.js to maintain a single source of truth.
 *
 * Magic numbers for volatility-adaptive wait multipliers are replaced by
 * named constants at the top of this file.
 */

import { getDB } from "../db.js";
import { log } from "../logger.js";
import { markOutOfRange, markInRange } from "./oor.js";
import { getTrackedPosition } from "./registry.js";
import { checkBbExits as _checkBbExits } from "../bb-strategy.js";

// ─── Volatility-adaptive constants ───────────────────────────────────────────
// These multiply the base outOfRangeWaitMinutes from config.management.

/** Volatility >= 7: OOR wait multiplier (50%) */
const OOR_WAIT_MULT_HIGH     = 0.5;
/** Volatility 4-6: OOR wait multiplier (75%) */
const OOR_WAIT_MULT_MEDIUM   = 0.75;
/** Volatility >= 7: trailing drop multiplier (1.5x) */
const TRAILING_DROP_MULT_HIGH = 1.5;

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield, BB).
 * Updates peak_pnl_pct, trailing_active, prev_pnl_pct in the SQLite registry.
 * OOR state is updated via markOutOfRange / markInRange (single source of truth).
 * @param {string} position_address - On-chain position address
 * @param {Object} positionData - Current position metrics from Meteora API
 * @param {number} positionData.pnl_pct - Current PnL percentage
 * @param {boolean} positionData.in_range - Whether position is currently in range
 * @param {number} [positionData.fee_per_tvl_24h] - 24h fee per TVL percentage
 * @param {number} [positionData.age_minutes] - Position age in minutes
 * @param {Object} config - Management config from config.js (used for BB checks)
 * @returns {Promise<Object|null>} { action: "STOP_LOSS"|"TRAILING_TP"|"OUT_OF_RANGE"|"LOW_YIELD"|"BB_EXIT", reason: string } or null
 */
export async function updatePnlAndCheckExits(position_address, positionData, config) {
  const { pnl_pct: currentPnlPct, in_range, fee_per_tvl_24h } = positionData;
  const pos = getTrackedPosition(position_address);

  if (!pos || pos.closed) return null;

  let updates = {};
  let changed = false;

  // Track peak PnL
  if (currentPnlPct != null && currentPnlPct > (pos.peak_pnl_pct ?? 0)) {
    updates.peak_pnl_pct = currentPnlPct;
    pos.peak_pnl_pct = currentPnlPct;
    changed = true;
  }

  // Persist current reading as prev_pnl_pct for the next call —
  // enables runManagementCycle to detect implausible PnL jumps (e.g. -5% → -99%)
  if (currentPnlPct != null) {
    updates.prev_pnl_pct = currentPnlPct;
    changed = true;
  }

  // Activate trailing TP once trigger threshold is reached
  if (config.management.trailingTakeProfit && !pos.trailing_active && currentPnlPct >= config.management.trailingTriggerPct) {
    updates.trailing_active = 1;
    pos.trailing_active = true;
    changed = true;
    log("info", "state", `Position ${position_address} trailing TP activated at ${currentPnlPct}% (peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state via single source of truth — NEVER write out_of_range_since directly
  if (in_range === false && !pos.out_of_range_since) {
    markOutOfRange(position_address);
    pos.out_of_range_since = new Date().toISOString(); // keep local cache in sync
  } else if (in_range === true && pos.out_of_range_since) {
    markInRange(position_address);
    pos.out_of_range_since = null; // keep local cache in sync
  }

  // Re-fetch position to ensure subsequent reads see DB-committed state
  const pos2 = getTrackedPosition(position_address);
  if (pos2) {
    pos.out_of_range_since = pos2.out_of_range_since;
  }

  if (changed) {
    const db = getDB();
    const keys = Object.keys(updates);
    if (keys.length > 0) {
      const setCols = keys.map((k) => `${k} = ?`).join(", ");
      const values = [...keys.map((k) => updates[k]), position_address];
      db.prepare(`UPDATE positions SET ${setCols} WHERE position = ?`).run(...values);
    }
  }

  // ── Volatility-adaptive adjustments ─────────────────────────────────────
  const vol = pos.volatility ?? 3;
  const oorWait = vol >= 7
    ? Math.round(config.management.outOfRangeWaitMinutes * OOR_WAIT_MULT_HIGH)
    : vol >= 4
    ? Math.round(config.management.outOfRangeWaitMinutes * OOR_WAIT_MULT_MEDIUM)
    : config.management.outOfRangeWaitMinutes;

  const adaptiveTrailingDrop = vol >= 7
    ? config.management.trailingDropPct * TRAILING_DROP_MULT_HIGH
    : config.management.trailingDropPct;

  // ── Stop loss ──────────────────────────────────────────────────────────────
  if (currentPnlPct != null && config.management.stopLossPct != null && currentPnlPct <= config.management.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${config.management.stopLossPct}%`,
    };
  }

  // ── Trailing TP ─────────────────────────────────────────────────────────────
  if (pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= adaptiveTrailingDrop) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${adaptiveTrailingDrop.toFixed(1)}%${vol >= 7 ? " [vol-adaptive]" : ""})`,
      };
    }
  }

  // ── Out of range too long ────────────────────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= oorWait) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${oorWait}m${vol >= 4 ? ` [vol-adaptive from ${config.management.outOfRangeWaitMinutes}m]` : ""})`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ──────────
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = config.management.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    config.management.minFeePerTvl24h != null &&
    fee_per_tvl_24h < config.management.minFeePerTvl24h &&
    (age_minutes != null && age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${config.management.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  // ── BB exit (5th signal) ────────────────────────────────────────────────────
  const bbExits = await checkBbExits([positionData], config.management);
  const bbExit = bbExits.get(position_address);
  if (bbExit) {
    return {
      action: "BB_EXIT",
      reason: bbExit.reason,
    };
  }

  return null;
}
