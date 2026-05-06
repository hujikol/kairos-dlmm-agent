/**
 * Executor module — execute management actions (close, claim).
 */

import { log } from "../../core/logger.js";
import { closePosition, claimFees } from "../../integrations/meteora/close.js";
import { pushNotification } from "../../notifications/queue.js";

/**
 * Execute a single close action.
 * @param {Object} p - position data
 * @param {string} reason - close reason
 * @param {Object} config - management config (for currency mode)
 * @returns {Object} { success, result, notification }
 */
export async function executeClose(p, reason, config) {
  const _cur = config.management.solMode ? "◎" : "$";
  log("info", "management:executor", `Direct CLOSE: ${p.pair} (${p.position}) — ${reason}`);
  try {
    const result = await closePosition({ position_address: p.position, reason });
    if (result.success !== false) {
      pushNotification({
        type: "close",
        pair: p.pair,
        pnlUsd: result.pnl_usd ?? p.pnl_usd ?? 0,
        pnlPct: result.pnl_pct ?? p.pnl_pct ?? 0,
        reason,
      });
      return { success: true, result, notification: `✅ Closed ${p.pair}: ${reason} (PnL: ${result.pnl_pct ?? p.pnl_pct ?? "?"}%)` };
    } else {
      log("error", "management:executor", `Direct CLOSE failed for ${p.pair}: ${result.error}`);
      return { success: false, result, notification: `❌ Close failed ${p.pair}: ${result.error}` };
    }
  } catch (e) {
    const errMsg = e?.message ?? String(e);
    log("error", "management:executor", `Direct CLOSE error for ${p.pair}: ${errMsg}`);
    return { success: false, result: { error: errMsg }, notification: `❌ Close error ${p.pair}: ${errMsg}` };
  }
}

/**
 * Execute a single claim action.
 * @param {Object} p - position data
 * @returns {Object} { success, result }
 */
export async function executeClaim(p) {
  log("info", "management:executor", `Direct CLAIM: ${p.pair} (${p.position})`);
  try {
    const result = await claimFees({ position_address: p.position });
    if (result.success !== false) {
      pushNotification({
        type: "claim",
        pair: p.pair,
        usd: p.unclaimed_fees_usd ?? 0,
      });
      return { success: true, result, notification: `💰 Claimed fees ${p.pair}: $${(p.unclaimed_fees_usd ?? 0).toFixed(2)}` };
    } else {
      log("warn", "management:executor", `Direct CLAIM failed for ${p.pair}: ${result.error}`);
      return { success: false, result };
    }
  } catch (e) {
    const errMsg = e?.message ?? String(e);
    log("error", "management:executor", `Direct CLAIM error for ${p.pair}: ${errMsg}`);
    return { success: false, result: { error: errMsg } };
  }
}

/**
 * Execute all close and claim actions.
 * @param {Array} closeActions - positions to close
 * @param {Array} claimActions - positions to claim
 * @param {Object} config - management config
 * @param {Map} actionMap - position→action map from computeManagementActions()
 * @returns {Object} { closeResults, claimResults, mgmtReportAdditions }
 */
export async function executeActions(closeActions, claimActions, config, actionMap) {
  const closeResults = [];
  const mgmtReportAdditions = [];

  // Execute close and claim actions in parallel — each is independent
  const [closeResultEntries, claimResultEntries] = await Promise.all([
    Promise.allSettled(closeActions.map(async (p) => {
      const a = actionMap?.get(p.position) || {};
      const reason = a?.reason || "agent decision";
      const { notification } = await executeClose(p, reason, config);
      return { position: p, reason, notification };
    })),
    Promise.allSettled(claimActions.map(async (p) => {
      const { notification } = await executeClaim(p);
      return { notification };
    })),
  ]);

  // Collect results, preserving order
  for (const r of closeResultEntries) {
    if (r.status === "fulfilled") {
      mgmtReportAdditions.push(r.value.notification);
      closeResults.push({ position: r.value.position, reason: r.value.reason });
    } else {
      mgmtReportAdditions.push(`❌ Close error: ${r.reason?.message ?? r.reason}`);
    }
  }
  for (const r of claimResultEntries) {
    if (r.status === "fulfilled" && r.value.notification) {
      mgmtReportAdditions.push(r.value.notification);
    } else if (r.status === "rejected") {
      mgmtReportAdditions.push(`❌ Claim error: ${r.reason?.message ?? r.reason}`);
    }
  }

  return { closeResults, claimResults: [], mgmtReportAdditions };
}
