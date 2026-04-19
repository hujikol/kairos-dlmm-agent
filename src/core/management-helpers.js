/**
 * Management-cycle helpers: deterministic rule engine, report builders,
 * post-trade notifications.
 */

import { log } from "./logger.js";
import { addrShort } from "../tools/addrShort.js";
import { escapeHTMLLocal } from "./cycle-helpers.js";
import {
  PNL_SUSPECT_PCT,
  PNL_SUSPECT_USD,
  MIN_POSITION_AGE_FOR_YIELD_CHECK_MS,
  MIN_LLM_OUTPUT_LEN,
  MAX_LLM_OUTPUT_DISPLAY,
  MAX_HTML_MSG_LEN,
  PRICE_FORMAT_THRESHOLD,
} from "./constants.js";
import { autoSwapRewardFees } from "../integrations/helius.js";
import { pushNotification, flushNotifications, hasPendingNotifications } from "../notifications/queue.js";
import { sendHTML, isEnabled as telegramEnabled } from "../notifications/telegram.js";
import { stripThink } from "../tools/caveman.js";

// ─── Deterministic rule engine ───────────────────────────────────────────────

/**
 * Compute management actions for all positions using deterministic rules.
 * Returns a Map of position_address → { action, rule?, reason? }
 * action: "CLOSE" | "CLAIM" | "STAY" | "INSTRUCTION"
 */
export function computeManagementActions(positionData, exitMap, config, getTrackedPosition) {
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
    const tracked = getTrackedPosition(p.position);
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

    // Rule 1: stop loss
    if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) {
      actionMap.set(p.position, { action: "CLOSE", rule: 1, reason: "stop loss" });
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
    // Rule 4: stale above range
    if (p.active_bin != null && p.upper_bin != null &&
        p.active_bin > p.upper_bin &&
        (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
      actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: "OOR" });
      continue;
    }
    // Rule 5: fee yield too low
    if (p.fee_per_tvl_24h != null &&
        p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
        (p.age_minutes ?? 0) >= MIN_POSITION_AGE_FOR_YIELD_CHECK_MS / 60_000) {
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

// ─── Management report builder ───────────────────────────────────────────────

/**
 * Build the markdown management report string.
 */
export function buildManagementReport(positionData, actionMap, positions, config) {
  const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
  const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);
  const cur = config.management.solMode ? "◎" : "$";

  let table = "ID  Pair        PnL     Yield   Status\n";
  table += "──  ──────────  ──────  ──────  ──────\n";

  const reportLines = positionData.map((p, i) => {
    const act = actionMap.get(p.position);
    const pnl = `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`.slice(0, 6).padEnd(6);
    const yield_pct = `${p.fee_per_tvl_24h ?? "?"}%`.slice(0, 6).padEnd(6);
    const statusIcon = p.in_range ? "🟢" : "🔴";
    const statusLabel = act.action === "INSTRUCTION" ? "HOLD" : act.action;

    table += `${String(i + 1).padEnd(2)}  ${p.pair.slice(0, 10).padEnd(10)}  ${pnl}  ${yield_pct}  ${statusIcon}${statusLabel}\n`;

    let detail = "";
    if (p.instruction) detail += `\nNote: "${p.instruction}"`;
    if (act.action === "CLOSE" && act.rule === "exit") detail += `\n⚡ Trailing TP: ${act.reason}`;
    if (act.action === "CLOSE" && act.rule && act.rule !== "exit") detail += `\nRule ${act.rule}: ${act.reason}`;
    if (act.action === "CLAIM") detail += `\n→ Claiming fees`;
    return detail ? `*${p.pair}*:${detail}` : null;
  }).filter(Boolean);

  const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
  const actionSummary = needsAction.length > 0
    ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
    : "no action";

  return `\`\`\`\n${table}\`\`\`\n` +
    (reportLines.length > 0 ? reportLines.join("\n\n") + "\n\n" : "") +
    `Summary: 💼 ${positions.length} pos | ${cur}${totalValue.toFixed(2)} | fees: ${cur}${totalUnclaimed.toFixed(2)} | ${actionSummary}`;
}

// ─── Post-trade: auto-swap reward tokens to SOL ───────────────────────────────

/**
 * Post-trade: auto-swap reward tokens to SOL and push notifications.
 */
export async function autoSwapAndNotify(executedActions) {
  if (executedActions.length === 0) return;
  log("info", "post_trade", `${executedActions.length} action(s) executed — checking for fee tokens to swap`);
  const swapResult = await autoSwapRewardFees(null, { forceRefresh: true });
  if (swapResult.swapped && swapResult.swapped.length > 0) {
    log("info", "post_trade", `Swapped ${swapResult.swapped.length} token(s) to SOL`);
    for (const swap of swapResult.swapped) {
      if (swap.success) {
        pushNotification({
          type: "swap",
          from: addrShort(swap.input_mint) || "FEE",
          to: "SOL",
          amountIn: swap.amount_in,
          amountOut: swap.amount_out,
          tx: swap.tx,
        });
      } else {
        log("warn", "post_trade", `Swap failed: ${swap.error}`);
        pushNotification({
          type: "swap_failed",
          from: addrShort(swap.input_mint) || "FEE",
          error: swap.error || "unknown",
        });
      }
    }
  }
}

// ─── Consolidated notification report ────────────────────────────────────────

/**
 * Build and send the consolidated HTML management report to Telegram.
 */
export function buildAndSendConsolidatedReport({ mgmtReport, oorPositions, positions }) {
  const notes = flushNotifications();
  const closes = notes.filter((n) => n.type === "close");
  const swaps = notes.filter((n) => n.type === "swap");
  const deploys = notes.filter((n) => n.type === "deploy");
  const oors = notes.filter((n) => n.type === "oor");
  const claims = notes.filter((n) => n.type === "claim");

  const now = new Date();
  const ts = now.toISOString().slice(11, 16) + " UTC";

  const parts = [];
  parts.push(`<b>⚙️ Management Cycle — ${ts}</b>`);

  // Deploys
  for (const d of deploys) {
    const range = d.priceRange
      ? ` | ${d.priceRange.min < PRICE_FORMAT_THRESHOLD ? d.priceRange.min.toExponential(3) : d.priceRange.min.toFixed(6)}–${d.priceRange.max < PRICE_FORMAT_THRESHOLD ? d.priceRange.max.toExponential(3) : d.priceRange.max.toFixed(6)}`
      : "";
    parts.push(`\n✅ <b>Deployed</b> ${escapeHTMLLocal(d.pair)}\n` +
      `  ${d.amountSol} SOL${range}\n` +
      (d.tx ? `  tx: <code>${escapeHTMLLocal(d.tx.slice(0, 12))}...</code>` : ""));
  }

  // Closes + related swaps
  for (const c of closes) {
    if (c.already_closed) {
      parts.push(
        `\n⚠️ <b>Close Failed</b> ${escapeHTMLLocal(c.pair)}\n` +
        `  Position may already be closed or untracked.\n` +
        `  Manual inspection recommended on Meteora.`
      );
      continue;
    }
    const sign = c.pnlUsd >= 0 ? "+" : "";
    parts.push(
      `\n🔒 <b>Closed</b> ${escapeHTMLLocal(c.pair)}\n` +
      `  PnL ${sign}$${(c.pnlUsd ?? 0).toFixed(2)} (${sign}${(c.pnlPct ?? 0).toFixed(2)}%)${c.reason ? ` — ${escapeHTMLLocal(c.reason)}` : ""}`
    );
  }

  // Swaps not associated with a close
  for (const s of swaps) {
    parts.push(
      `\n🔄 <b>Swap</b> ${escapeHTMLLocal(String(s.from))} → ${escapeHTMLLocal(String(s.to))}\n` +
      `  ${s.amountIn} → ${s.amountOut}\n` +
      (s.tx ? `  tx: <code>${escapeHTMLLocal(s.tx.slice(0, 12))}...</code>` : "")
    );
  }

  // OOR alerts
  const allOors = [...oors];
  if (allOors.length > 0) {
    const headerParts = [allOors.length === 1 ? "Out of Range" : `Out of Range — ${allOors.length} positions`];
    parts.push(`\n⚠️ <b>${headerParts}</b>`);
    for (const o of allOors) {
      const feeStr = o.feeTvl != null ? ` | fee/TVL ${o.feeTvl}%` : "";
      parts.push(`  • ${escapeHTMLLocal(o.pair)} | OOR ${o.minutesOOR}m${feeStr}`);
    }
  }

  // Claims
  for (const c of claims) {
    parts.push(`\n💰 <b>Fees claimed</b> ${escapeHTMLLocal(c.pair)} — $${(c.usd ?? 0).toFixed(2)}`);
  }

  // Failed swaps
  const failedSwaps = notes.filter((n) => n.type === "swap_failed");
  for (const f of failedSwaps) {
    parts.push(`\n❌ <b>Swap failed</b> ${escapeHTMLLocal(String(f.from))} → SOL: ${escapeHTMLLocal(f.error)}`);
  }

  // LLM report snippet (management cycle output, truncated)
  if (mgmtReport) {
    const cleaned = stripThink(mgmtReport);
    if (cleaned && cleaned.length > MIN_LLM_OUTPUT_LEN) {
      const maxLen = MAX_LLM_OUTPUT_DISPLAY;
      const text = cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
      parts.push(`\n\n<pre>${escapeHTMLLocal(text)}</pre>`);
    }
  }

  // Healthy positions note
  const healthyCount = positions.length - oorPositions.length;
  if (healthyCount > 0 && closes.length === 0 && deploys.length === 0) {
    parts.push(`\nℹ️ No action needed: ${healthyCount} position${healthyCount === 1 ? "" : "s"} healthy`);
  }

  const html = parts.join("\n");
  if (html && html.length < MAX_HTML_MSG_LEN) {
    sendHTML(html).catch(() => {});
  }
}
