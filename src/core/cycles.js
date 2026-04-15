import "dotenv/config";
import { agentLoop } from "../agent.js";
import { log } from "./logger.js";
import { getMyPositions, getActiveBin } from "./integrations/meteora.js";
import { getWalletBalances, autoSwapRewardFees } from "./integrations/helius.js";
import { getTopCandidates } from "./screening/discovery.js";
import { addrShort } from "./tools/addrShort.js";
import { config, computeDeployAmount } from "./config.js";
import {
  timers,
  _managementBusy,
  _screeningBusy,
  _screeningLastTriggered,
} from "./scheduler.js";
import { flushNotifications, hasPendingNotifications, pushNotification } from "./notifications/queue.js";
import { sendHTML, isEnabled as telegramEnabled } from "./notifications/telegram.js";
import { getTrackedPosition } from "./core/state/registry.js";
import { updatePnlAndCheckExits } from "./core/state/pnl.js";
import { getActiveStrategy } from "./core/strategy-library.js";
import { recordPositionSnapshot, recallForPool, isTokenToxic } from "./features/pool-memory.js";
import { checkSmartWalletsOnPool } from "./features/smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./integrations/jupiter.js";
import { detectMarketPhase, PHASE_CONFIG } from "./core/phases.js";
import { computeTokenScore } from "./core/token-score.js";
import { findStrategiesForPhase } from "./core/lparmy-strategies.js";
import { checkDailyCircuitBreaker } from "./core/daily-tracker.js";
import { simulatePoolDeploy } from "./core/simulator.js";
import { checkTokenCorrelation } from "./core/correlation.js";
import { stripThink } from "./tools/caveman.js";

import {
  PNL_SUSPECT_PCT,
  PNL_SUSPECT_USD,
  MIN_POSITION_AGE_FOR_YIELD_CHECK_MS,
  SCREENING_COOLDOWN_MS,
  MIN_LLM_OUTPUT_LEN,
  MAX_LLM_OUTPUT_DISPLAY,
  MAX_HTML_MSG_LEN,
  PRICE_FORMAT_THRESHOLD,
} from "./constants.js";

// ─── HTML escaper ─────────────────────────────────────────────────────────────

export function escapeHTMLLocal(text) {
  if (!text) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── Deterministic rule engine ───────────────────────────────────────────────

/**
 * Compute management actions for all positions using deterministic rules.
 * Returns a Map of position_address → { action, rule?, reason? }
 * action: "CLOSE" | "CLAIM" | "STAY" | "INSTRUCTION"
 */
function computeManagementActions(positionData, exitMap, config, getTrackedPosition) {
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
function buildManagementReport(positionData, actionMap, positions, config) {
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
async function autoSwapAndNotify(executedActions) {
  if (executedActions.length === 0) return;
  log("info", "post_trade", `${executedActions.length} action(s) executed — checking for fee tokens to swap`);
  const swapResult = await autoSwapRewardFees();
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

function buildAndSendConsolidatedReport({ mgmtReport, oorPositions, positions }) {
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

// ─── Screening helpers ────────────────────────────────────────────────────────

/**
 * Reconstitute candidates with smart-wallet data, narrative, token info,
 * pool memory, market phase, and token score.
 */
async function fetchAndReconCandidates(candidates) {
  return Promise.all(candidates.map(async (pool, idx) => {
    await new Promise(r => setTimeout(r, idx * 100)); // stagger to avoid 429s
    const mint = pool.base?.mint;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: pool.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    return {
      pool,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
      mem: recallForPool(pool.pool),
      phase: detectMarketPhase(pool),
      score: computeTokenScore(pool, tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null),
    };
  }));
}

/**
 * Apply hard filters: launchpad blocklist, bot-holder %, toxic tokens,
 * and cross-portfolio token correlation.
 */
function applyHardFilters(allCandidates, config, prePositions) {
  return allCandidates.filter(({ pool, ti }) => {
    const launchpad = ti?.launchpad ?? null;
    if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
      log("info", "screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
      return false;
    }
    const botPct = ti?.audit?.bot_holders_pct;
    const maxBotHoldersPct = config.screening.maxBotHoldersPct;
    if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
      log("info", "screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
      return false;
    }
    const baseMint = pool.base?.mint;
    if (baseMint && isTokenToxic(baseMint)) {
      log("info", "screening", `Toxic token filter: dropped ${pool.name} — base token has >66% loss rate across 3+ deploys`);
      return false;
    }
    if (baseMint) {
      const corr = checkTokenCorrelation(prePositions.positions || [], baseMint);
      if (corr.exceeds) {
        log("info", "screening", `Correlation filter: dropped ${pool.name} — already ${corr.count} position(s) on token`);
        return false;
      }
    }
    return true;
  });
}

/**
 * Build compact text blocks for each candidate, for injection into the LLM prompt.
 */
function buildCandidateBlocks(passing, activeBinResults, simulations) {
  return passing.map(({ pool, sw, n, ti, mem, phase, score }, i) => {
    const botPct = ti?.audit?.bot_holders_pct ?? "?";
    const top10Pct = ti?.audit?.top_holders_pct ?? "?";
    const feesSol = ti?.global_fees_sol ?? "?";
    const launchpad = ti?.launchpad ?? null;
    const priceChange = ti?.stats_1h?.price_change;
    const netBuyers = ti?.stats_1h?.net_buyers;
    const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
    const sim = simulations[i];

    const okxParts = [
      pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
      pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
      pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
      pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
      pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
      pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
      pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
    ].filter(Boolean).join(", ");

    const okxTags = [
      pool.smart_money_buy    ? "smart_money_buy"    : null,
      pool.kol_in_clusters    ? "kol_in_clusters"    : null,
      pool.dex_boost          ? "dex_boost"          : null,
      pool.dex_screener_paid  ? "dex_screener_paid"  : null,
      pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
    ].filter(Boolean).join(", ");

    const block = [
      `POOL: ${pool.name} (${pool.pool})`,
      `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
      `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
      okxParts ? `  okx: ${okxParts}` : null,
      okxTags  ? `  tags: ${okxTags}` : null,
      pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
      `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
      `  market_phase: ${phase} | token_score: ${score.score}/${score.max} (${score.label})`,
      activeBin != null ? `  active_bin: ${activeBin}` : null,
      `  sim: daily_fees=$${sim.daily_fees_usd} | est_IL=$${sim.expected_il_usd} | net_daily=$${sim.net_daily_usd} | risk=${sim.risk_score}/100 | confidence=${sim.confidence}/100 | passes=${sim.passes ? "YES" : "NO"}`,
      priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
      n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
      mem ? `  memory: ${mem}` : null,
    ].filter(Boolean).join("\n");

    return block;
  });
}

// ─── Management cycle ─────────────────────────────────────────────────────────

const IS_DRY_RUN = process.env.DRY_RUN === "true";

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("info", "cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];

  try {
    // Daily PnL circuit breaker
    const circuit = checkDailyCircuitBreaker();
    log("info", "daily-pnl", `Circuit breaker: ${circuit.action} (realized: ${circuit.pnl?.toFixed(2) ?? "N/A"} USD, reason: ${circuit.reason || "normal"})`);
    if (circuit.action === "halt") {
      log("warn", "daily-pnl", `CIRCUIT BREAKER: daily loss limit hit — skipping new deployments this cycle`);
      // Still manage existing positions (close/claim) in halt mode
    }

    const [livePositions, currentBalance] = await Promise.all([
      getMyPositions({ force: true }).catch(e => { log("warn", "cron", `getMyPositions failed: ${e?.message ?? e}`); return null; }),
      getWalletBalances(),
    ]);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("info", "cron", "No open positions — triggering screening cycle");
      runScreeningCycle().catch((e) => log("error", "cron", `Triggered screening failed: ${e.message}`));
      return null;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("info", "state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule engine ─────────────────────────────────────
    const actionMap = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    // ── Build JS report ──────────────────────────────────────────────
    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    mgmtReport = buildManagementReport(positionData, actionMap, positions, config);

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("info", "cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const cur = config.management.solMode ? "◎" : "$";
      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, Math.min(config.llm.maxSteps, 10), [], "MANAGER", config.llm.managementModel, 2048, { portfolio: currentBalance, positions: livePositions });

      mgmtReport += `\n\n${content}`;

      // ═══════════════════════════════════════════
      //  POST-TRADE: Auto-swap fee tokens to SOL
      // ═══════════════════════════════════════════
      const executedActions = actionPositions.filter(p => {
        const a = actionMap.get(p.position);
        return a?.action === "CLAIM" || a?.action === "CLOSE";
      });
      await autoSwapAndNotify(executedActions);
    } else {
      log("info", "cron", "Management: all positions STAY — skipping LLM");
    }

    // Trigger screening after management if we expect to be under max positions
    // Skip if circuit breaker is in halt mode
    const closesAttempted = needsAction.filter(a => a.action === "CLOSE" || a.action === "INSTRUCTION").length;
    const afterCount = Math.max(0, positions.length - closesAttempted);
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > SCREENING_COOLDOWN_MS && circuit.action !== "halt") {
      log("info", "cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("error", "cron", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("error", "cron", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      // Batch OOR positions
      const oorPositions = positions.filter(
        (p) => !p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes
      );
      for (const p of oorPositions) {
        pushNotification({
          type: "oor",
          pair: p.pair,
          position: p.position,
          minutesOOR: p.minutes_out_of_range,
          feeTvl: p.fee_per_tvl_24h ?? null,
        });
      }

      // Build consolidated message if there's anything to say
      const isAllHealthy = positions.length > 0 &&
        oorPositions.length === 0 &&
        !hasPendingNotifications();

      if (!isAllHealthy || mgmtReport) {
        buildAndSendConsolidatedReport({ mgmtReport, oorPositions, positions }).catch(() => {});
      }
    }
  }
  return mgmtReport;
}

// ─── Screening cycle ─────────────────────────────────────────────────────────

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("info", "screening", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("info", "cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      _screeningBusy = false;
      return null;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired && !IS_DRY_RUN) {
      log("info", "cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      _screeningBusy = false;
      return null;
    }
    if (preBalance.sol < minRequired && IS_DRY_RUN) {
      log("info", "cron", `DRY RUN — bypassing SOL check (${preBalance.sol.toFixed(3)} SOL, would need ${minRequired})`);
    }
  } catch (e) {
    log("error", "cron", `Screening pre-check failed: ${e.message}`);
    _screeningBusy = false;
    return null;
  }
  timers.screeningLastRun = Date.now();
  log("info", "cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  let screenReport = null;
  let canDeploy = true; // circuit breaker may block new deployments
  let screeningMode = "normal";

  // Daily PnL circuit breaker
  const circuit = checkDailyCircuitBreaker();
  log("info", "daily-pnl", `Screening circuit: ${circuit.action} (realized: $${(circuit.pnl || 0).toFixed(2)}, reason: ${circuit.reason || "normal"})`);
  if (circuit.action === "halt") {
    log("warn", "daily-pnl", `CIRCUIT BREAKER (screening): daily loss limit hit — skipping screening entirely`);
    _screeningBusy = false;
    return null;
  }
  if (circuit.action === "preserve") {
    log("info", "daily-pnl", `Daily profit target has been met — skipping new deployments this cycle`);
    canDeploy = false;
    screeningMode = "preserve";
  }

  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmountResult = computeDeployAmount(currentBalance.sol, prePositions.total_positions || 0);
    const deployAmount = deployAmountResult.amount || 0;
    log("info", "cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL, positions: ${prePositions.total_positions || 0})`);

    // Load active strategy (phase info injected later after candidate recon)
    const activeStrategy = getActiveStrategy();

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(e => { log("warn", "screening", `getTopCandidates failed: ${e?.message ?? e}`); return null; });
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    const allCandidates = await fetchAndReconCandidates(candidates);

    // Hard filters after token recon — block launchpads, excessive bots, and toxic tokens
    const passing = applyHardFilters(allCandidates, config, prePositions);

    if (passing.length === 0) {
      screenReport = `No candidates available (all blocked by launchpad filter).`;
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Determine dominant market phase (most common among passing candidates)
    const phaseCounts = {};
    for (const c of passing) { phaseCounts[c.phase] = (phaseCounts[c.phase] || 0) + 1; }
    const dominantPhase = Object.entries(phaseCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "normal";
    const phaseMeta = PHASE_CONFIG[dominantPhase];
    const phaseStrategies = findStrategiesForPhase(dominantPhase, 5);

    // Build the strategy + phase prompt block (requires dominantPhase from candidates)
    const strategyNames = phaseStrategies.map(s => s.name).join(", ");
    const phaseBlock = `MARKET PHASE: ${dominantPhase} — ${phaseMeta.description}\nPhase-matched strategies: ${strategyNames}\nToken scores are included per candidate — prefer GOOD or EXCELLENT tokens.`;
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}\n${phaseBlock}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.\n${phaseBlock}`;

    // Run simulator for all passing candidates
    const simulations = passing.map(({ pool }) => simulatePoolDeploy(pool, deployAmount, preBalance.usd ?? 0));

    // Build compact candidate blocks
    const candidateBlocks = buildCandidateBlocks(passing, activeBinResults, simulations);

    // Build mode flag for prompt
    const modeNote = !canDeploy
      ? `\nNOTE: Daily profit target has been met. This is a REDUCED screening cycle — review candidates but do NOT deploy new positions today.`
      : "";

    const { content } = await agentLoop(`
SCREENING CYCLE${modeNote}
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

CONVICTION SIZING MATRIX (enforced by safety check):
- very_high: LPers confirm + smart wallets present + strong fundamentals → ${prePositions.total_positions === 0 ? '1.05' : '0.70'} SOL
  (3x = 1.05 SOL only allowed at 0 positions; 1+ positions caps at 0.70 SOL)
- high: Good fundamentals, LPers match → 0.53 SOL
- normal: Standard pass → 0.35 SOL
Declare conviction in deploy_position. The safety layer computes the exact amount from this matrix — if you specify a different amount_y, it will be overridden.
Daily PnL today: $${circuit.pnl?.toFixed(2) ?? "0"}.00 (profit target: $${circuit.threshold}, loss limit: $${circuit.lossLimit})

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Review each candidate's simulation results (sim: line). Prefer pools with passes=YES, low risk_score, and high confidence.
2. Pick the best candidate based on narrative quality, smart wallets, pool metrics, and simulation output.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(35 + (volatility/5)*34) clamped to [35,69].
4. Report in this exact format (no tables, no extra sections):
    *Decision:* DEPLOYED PAIR
    *pool:* <name> | <pool address>
    *amount:* <deploy amount> SOL | *strategy*=<strategy> | *active_bin*=<bin>
    *metrics:* bin_step=X | fee=X% | fee_tvl=X% | volume=$X | tvl=$X | volatility=X | organic=X | mcap=$X
    *holder_audit:* top10=X% | bots=X% | fees=XSOL | token_age=Xh
    *okx:* risk=X | bundle=X% | sniper=X% | suspicious=X% | ath=X% | rugpull=Y/N | wash=Y/N
    *smart_wallets:* <names or none>
    *range:* minPrice→maxPrice (downside=(minPrice/maxPrice-1)*100%)
    *sim:* daily_fees=$X | est_IL=$X | net_daily=$X | risk=X/100 | confidence=X/100
    *narrative:* <1-2 sentences on what the token/pool is and why it has attention>
    *analysis:* <2-4 sentences covering why this setup is attractive right now, key risks, and what outweighed the alternatives>
    *reason:* <one decisive sentence explaining why this pool won over the rest>
    *rejected:* <one short sentence on why the next best alternatives were passed over>
5. If no pool qualifies, report in this exact format instead:
    *Decision:* NO DEPLOY
    *analysis:* <2-4 sentences explaining why current candidates were rejected>
    *rejected:* <short semicolon-separated reasons for the top candidates that were skipped>
      `, config.llm.screenerMaxSteps, [], "SCREENER", config.llm.screeningModel, 2048, { portfolio: preBalance, positions: prePositions });
    screenReport = content;
  } catch (error) {
    log("error", "cron", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      // Only send if agent actually deployed a position (action taken)
      if (screenReport && /DEPLOYED/i.test(screenReport)) {
        sendHTML(`<b>🔍 Screening Cycle</b>\n\n<pre>${escapeHTMLLocal(stripThink(screenReport))}</pre>`).catch(() => { });
      }
    }
  }
  return screenReport;
}
