/**
 * Deterministic rule engine for management cycle.
 * Computes actions for each position: CLOSE | CLAIM | STAY | INSTRUCTION
 */

import { log } from "../../core/logger.js";
import {
  PNL_SUSPECT_PCT,
  PNL_SUSPECT_USD,
  MIN_POSITION_AGE_FOR_YIELD_CHECK_MS,
} from "../../core/constants.js";
import { getTrackedPosition } from "../state/registry.js";
import { computeAdaptiveStopLoss, computeAdaptiveOorWait } from "../state/pnl.js";

/**
 * Compute management actions for all positions using deterministic rules.
 * Returns a Map of position_address → { action, rule?, reason? }
 * action: "CLOSE" | "CLAIM" | "STAY" | "INSTRUCTION"
 */
export function computeManagementActions(positionData, exitMap, config, getTrackedPositionFn) {
  const actionMap = new Map();
  for (const p of positionData) {
    // Hard exit — highest priority
    if (exitMap.has(p.position)) {
      actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
      continue;
    }
    // Instruction-set — pass to LLM, can't parse in JS
    if (p.instruction) {
      actionMap.set(p.position, { action: "INSTRUCTION" });
      continue;
    }

    // Sanity-check PnL against tracked history — API sometimes returns bad data
    const tracked = getTrackedPositionFn ? getTrackedPositionFn(p.position) : getTrackedPosition(p.position);
    const pnlSuspect = (() => {
      if (p.pnl_pct == null) return false;
      if (p.pnl_pct > PNL_SUSPECT_PCT) return false;
      if (tracked?.amount_sol && (p.total_value_usd ?? 0) > PNL_SUSPECT_USD) {
        const prev = tracked.prev_pnl_pct;
        if (prev == null || prev > PNL_SUSPECT_PCT) {
          log("warn", "cron", `Suspect PnL for ${p.pair}: was ${prev ?? "?"}% → now ${p.pnl_pct}% (pos still has value) — skipping PnL rules`);
          return true;
        }
      }
      return false;
    })();

    // Rule 1: stop loss (volatility-adaptive)
    const trackedForVol = getTrackedPositionFn ? getTrackedPositionFn(p.position) : getTrackedPosition(p.position);
    const vol = trackedForVol?.volatility ?? 3;
    const binCount = p.lower_bin != null && p.upper_bin != null ? Math.abs(p.upper_bin - p.lower_bin) : null;
    const adaptiveStopLoss = computeAdaptiveStopLoss(config.management, vol, binCount);
    if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= adaptiveStopLoss) {
      actionMap.set(p.position, { action: "CLOSE", rule: 1, reason: `stop loss (vol-adaptive: ${adaptiveStopLoss}%)` });
      continue;
    }
    // Rule 2: take profit
    if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
      actionMap.set(p.position, { action: "CLOSE", rule: 2, reason: "take profit" });
      continue;
    }
    // Rule 3: pumped far above range
    if (p.active_bin != null && p.upper_bin != null &&
        p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
      actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: "pumped far above range" });
      continue;
    }
    // Rule 4: stale above range (volatility-adaptive OOR wait)
    const adaptiveOorWait = computeAdaptiveOorWait(config.management, vol);
    if (p.active_bin != null && p.upper_bin != null &&
        p.active_bin > p.upper_bin &&
        (p.minutes_out_of_range ?? 0) >= adaptiveOorWait) {
      actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: `OOR (vol-adaptive wait: ${adaptiveOorWait}m)` });
      continue;
    }
    // Rule 5: fee yield too low
    if (p.fee_per_tvl_24h != null &&
        p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
        (p.age_minutes ?? 0) >= MIN_POSITION_AGE_FOR_YIELD_CHECK_MS / 60000) {
      actionMap.set(p.position, { action: "CLOSE", rule: 5, reason: "low yield" });
      continue;
    }
    // Claim rule
    if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
      actionMap.set(p.position, { action: "CLAIM" });
      continue;
    }
    actionMap.set(p.position, { action: "STAY" });
  }
  return actionMap;
}
