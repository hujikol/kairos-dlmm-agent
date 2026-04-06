import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./core/logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./integrations/meteora.js";
import { getWalletBalances, autoSwapRewardFees, swapAllTokensToSol } from "./integrations/helius.js";
import { getTopCandidates } from "./screening/discovery.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./core/lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, isEnabled as telegramEnabled } from "./notifications/telegram.js";
import { flushNotifications, hasPendingNotifications, pushNotification } from "./notifications/queue.js";
import { generateBriefing } from "./notifications/briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits } from "./core/state.js";
import { getActiveStrategy } from "./core/strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, isTokenToxic } from "./features/pool-memory.js";
import { checkSmartWalletsOnPool } from "./features/smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./integrations/jupiter.js";
import { detectMarketPhase, PHASE_CONFIG } from "./core/phases.js";
import { computeTokenScore } from "./core/token-score.js";
import { findStrategiesForPhase } from "./core/lparmy-strategies.js";
import { checkDailyCircuitBreaker } from "./core/daily-tracker.js";
import { simulatePoolDeploy } from "./core/simulator.js";
import { checkTokenCorrelation } from "./core/correlation.js";

log("info", "startup", "DLMM LP Agent starting...");
log("info", "startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("info", "startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

const TP_PCT = config.management.takeProfitFeePct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function escapeHTML(text) {
  if (!text) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function runBriefing() {
  log("info", "cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("error", "cron", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("info", "cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("info", "cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    // Daily PnL circuit breaker
    const circuit = checkDailyCircuitBreaker();
    log("info", "daily-pnl", `Circuit breaker: ${circuit.action} (realized: ${circuit.pnl?.toFixed(2) ?? "N/A"} USD, reason: ${circuit.reason || "normal"})`);
    if (circuit.action === "halt") {
      log("warn", "daily-pnl", `CIRCUIT BREAKER: daily loss limit hit — skipping new deployments this cycle`);
      // Still manage existing positions (close/claim) in halt mode
    }

    const [livePositions, currentBalance] = await Promise.all([
      getMyPositions({ force: true }).catch(() => null),
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

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
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

      // Sanity-check PnL against tracked initial deposit — API sometimes returns bad data
      // giving -99% PnL which would incorrectly trigger stop loss
      const tracked = getTrackedPosition(p.position);
      const pnlSuspect = (() => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false; // only flag extreme negatives
        // Cross-check: if we have a tracked deposit and current value isn't near zero, it's bad data
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log("warn", "cron", `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value — skipping PnL rules`);
          return true;
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
          (p.age_minutes ?? 0) >= 60) {
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

    // ── Build JS report ──────────────────────────────────────────────
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

    mgmtReport = `\`\`\`\n${table}\`\`\`\n` +
      (reportLines.length > 0 ? reportLines.join("\n\n") + "\n\n" : "") +
      `Summary: 💼 ${positions.length} pos | ${cur}${totalValue.toFixed(2)} | fees: ${cur}${totalUnclaimed.toFixed(2)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("info", "cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

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

      if (executedActions.length > 0) {
        log("info", "post_trade", `${executedActions.length} action(s) executed — checking for fee tokens to swap`);
        const swapResult = await autoSwapRewardFees();
        if (swapResult.swapped && swapResult.swapped.length > 0) {
          log("info", "post_trade", `Swapped ${swapResult.swapped.length} token(s) to SOL`);
          for (const swap of swapResult.swapped) {
            if (swap.success) {
              pushNotification({
                type: "swap",
                from: swap.input_mint?.slice(0, 8) || "FEE",
                to: "SOL",
                amountIn: swap.amount_in,
                amountOut: swap.amount_out,
                tx: swap.tx,
              });
            } else {
              log("warn", "post_trade", `Swap failed: ${swap.error}`);
              pushNotification({
                type: "swap_failed",
                from: swap.input_mint?.slice(0, 8) || "FEE",
                error: swap.error || "unknown",
              });
            }
          }
        }
      }
    } else {
      log("info", "cron", "Management: all positions STAY — skipping LLM");
    }

    // Trigger screening after management if we expect to be under max positions
    // Skip if circuit breaker is in halt mode
    const closesAttempted = needsAction.filter(a => a.action === "CLOSE" || a.action === "INSTRUCTION").length;
    const afterCount = Math.max(0, positions.length - closesAttempted);
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs && circuit.action !== "halt") {
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

// ═══════════════════════════════════════════
//  CONSOLIDATED NOTIFICATION REPORT
// ═══════════════════════════════════════════

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
      ? ` | ${d.priceRange.min < 0.0001 ? d.priceRange.min.toExponential(3) : d.priceRange.min.toFixed(6)}–${d.priceRange.max < 0.0001 ? d.priceRange.max.toExponential(3) : d.priceRange.max.toFixed(6)}`
      : "";
    parts.push(`\n✅ <b>Deployed</b> ${escapeHTML(d.pair)}\n` +
      `  ${d.amountSol} SOL${range}\n` +
      (d.tx ? `  tx: <code>${escapeHTML(d.tx.slice(0, 12))}...</code>` : ""));
  }

  // Closes + related swaps
  for (const c of closes) {
    const sign = c.pnlUsd >= 0 ? "+" : "";
    parts.push(
      `\n🔒 <b>Closed</b> ${escapeHTML(c.pair)}\n` +
      `  PnL ${sign}$${(c.pnlUsd ?? 0).toFixed(2)} (${sign}${(c.pnlPct ?? 0).toFixed(2)}%)${c.reason ? ` — ${escapeHTML(c.reason)}` : ""}`
    );
  }

  // Swaps not associated with a close
  for (const s of swaps) {
    parts.push(
      `\n🔄 <b>Swap</b> ${escapeHTML(String(s.from))} → ${escapeHTML(String(s.to))}\n` +
      `  ${s.amountIn} → ${s.amountOut}\n` +
      (s.tx ? `  tx: <code>${escapeHTML(s.tx.slice(0, 12))}...</code>` : "")
    );
  }

  // OOR alerts
  const allOors = [...oors];
  if (allOors.length > 0) {
    const headerParts = [allOors.length === 1 ? "Out of Range" : `Out of Range — ${allOors.length} positions`];
    parts.push(`\n⚠️ <b>${headerParts}</b>`);
    for (const o of allOors) {
      const feeStr = o.feeTvl != null ? ` | fee/TVL ${o.feeTvl}%` : "";
      parts.push(`  • ${escapeHTML(o.pair)} | OOR ${o.minutesOOR}m${feeStr}`);
    }
  }

  // Claims
  for (const c of claims) {
    parts.push(`\n💰 <b>Fees claimed</b> ${escapeHTML(c.pair)} — $${(c.usd ?? 0).toFixed(2)}`);
  }

  // Failed swaps
  const failedSwaps = notes.filter((n) => n.type === "swap_failed");
  for (const f of failedSwaps) {
    parts.push(`\n❌ <b>Swap failed</b> ${escapeHTML(String(f.from))} → SOL: ${escapeHTML(f.error)}`);  
  }

  // LLM report snippet (management cycle output, truncated)
  if (mgmtReport) {
    const cleaned = stripThink(mgmtReport);
    if (cleaned && cleaned.length > 5) {
      const maxLen = 2000;
      const text = cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
      parts.push(`\n\n<pre>${escapeHTML(text)}</pre>`);
    }
  }

  // Healthy positions note
  const healthyCount = positions.length - oorPositions.length;
  if (healthyCount > 0 && closes.length === 0 && deploys.length === 0) {
    parts.push(`\nℹ️ No action needed: ${healthyCount} position${healthyCount === 1 ? "" : "s"} healthy`);
  }

  const html = parts.join("\n");
  if (html && html.length < 4096) {
    sendHTML(html).catch(() => {});
  }
}

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
    if (preBalance.sol < minRequired && process.env.DRY_RUN !== "true") {
      log("info", "cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      _screeningBusy = false;
      return null;
    }
    if (preBalance.sol < minRequired && process.env.DRY_RUN === "true") {
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
    log("info", "daily-pnl", `Daily profit target met — skipping new deployments this cycle`);
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
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    const allCandidates = await Promise.all(candidates.map(async (pool, idx) => {
      await new Promise(r => setTimeout(r, idx * 100)); // staggered parallel execution
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

    // Hard filters after token recon — block launchpads, excessive bots, and toxic tokens
    const passing = allCandidates.filter(({ pool, ti }) => {
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
      // Token toxicity check — skip tokens that consistently lose across pools
      const baseMint = pool.base?.mint;
      if (baseMint && isTokenToxic(baseMint)) {
        log("info", "screening", `Toxic token filter: dropped ${pool.name} — base token has >66% loss rate across 3+ deploys`);
        return false;
      }
      // Cross-portfolio correlation: skip tokens with existing exposure
      if (baseMint) {
        const corr = checkTokenCorrelation(prePositions.positions || [], baseMint);
        if (corr.exceeds) {
          log("info", "screening", `Correlation filter: dropped ${pool.name} — already ${corr.count} position(s) on token`);
          return false;
        }
      }
      return true;
    });

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
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem, phase, score }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
      const sim = simulations[i];

      // OKX signals
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
   bins_below = round(35 + (volatility/5)*55) clamped to [35,90].
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
        sendHTML(`<b>🔍 Screening Cycle</b>\n\n<pre>${escapeHTML(stripThink(screenReport))}</pre>`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);



  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("info", "state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("error", "cron", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("info", "state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("info", "cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("info", "shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("info", "shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  // Telegram bot — queue messages received while busy, drain after each task
  async function drainTelegramQueue() {
    while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
      const queued = _telegramQueue.shift();
      await telegramHandler(queued);
    }
  }

  async function telegramHandler(text) {
    if (_managementBusy || _screeningBusy || busy) {
      if (_telegramQueue.length < 5) {
        _telegramQueue.push(text);
        sendHTML(`⏳ <b>Queued</b> (${_telegramQueue.length} in queue): "<i>${escapeHTML(text.slice(0, 60))}</i>"`).catch(() => {});
      } else {
        sendHTML("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
      }
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendHTML(briefing);
      } catch (e) {
        await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => { });
      }
      return;
    }

    if (text === "/balance") {
      try {
        const wallet = await getWalletBalances();
        const cur = config.management.solMode ? "◎" : "$";
        
        let table = "Token     Balance      Value\n";
        table += "────────  ───────────  ──────\n";
        
        // Add SOL
        table += `SOL       ${wallet.sol.toFixed(4).padEnd(11)}  $${wallet.sol_usd.toFixed(2)}\n`;
        
        // Add other non-zero tokens
        wallet.tokens.filter(t => t.symbol !== "SOL" && t.usd > 0.01).forEach(t => {
          const sym = t.symbol.slice(0, 8).padEnd(8);
          const bal = t.balance.toString().slice(0, 11).padEnd(11);
          const val = `$${t.usd.toFixed(2)}`;
          table += `${sym}  ${bal}  ${val}\n`;
        });
        
        await sendHTML(
          `<b>💰 Wallet Balance</b>\n\n` +
          `<pre>${escapeHTML(table)}</pre>\n` +
          `<b>Total:</b> $${wallet.total_usd.toFixed(2)}`
        );
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    if (text === "/status") {
      try {
        const [wallet, positionsData] = await Promise.all([
          getWalletBalances(),
          getMyPositions({ force: true })
        ]);
        const { positions, total_positions } = positionsData;
        const cur = config.management.solMode ? "◎" : "$";
        
        let table = "ID  Pair        PnL     Value\n";
        table += "──  ──────────  ──────  ──────\n";
        positions.forEach((p, i) => {
          const pair = p.pair.slice(0, 10).padEnd(10);
          const pnl = `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`.padEnd(6);
          const val = `${cur}${p.total_value_usd}`.padEnd(6);
          table += `${String(i + 1).padEnd(2)}  ${pair}  ${pnl}  ${val}\n`;
        });
        
        const posBlock = total_positions > 0 ? `<pre>${escapeHTML(table)}</pre>\n` : "<i>No open positions.</i>\n";
        await sendHTML(
          `<b>📊 Status Report</b>\n\n` +
          posBlock +
          `<b>Wallet:</b> ${wallet.sol.toFixed(4)} SOL ($${wallet.sol_usd})\n` +
          `<b>SOL Price:</b> $${wallet.sol_price}`
        );
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    if (text === "/candidates") {
      try {
        const { candidates } = await getTopCandidates({ limit: 5 });
        if (!candidates?.length) { await sendMessage("No candidates found."); return; }
        
        let table = "#   Pool        fee/TVL  vol    org\n";
        table += "──  ──────────  ───────  ─────  ───\n";
        candidates.forEach((p, i) => {
          const name = p.name.slice(0, 10).padEnd(10);
          const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.slice(0, 5).padStart(7);
          const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(5);
          const org = String(p.organic_score).padStart(3);
          table += `${String(i + 1).padEnd(2)}  ${name}  ${ftvl}  ${vol}  ${org}\n`;
        });
        
        await sendHTML(`<b>🔍 Top Candidates</b>\n\n<pre>${escapeHTML(table)}</pre>`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    if (text === "/screen") {
      runScreeningCycle().catch((e) => log("error", "cron", `Manual screening failed: ${e.message}`));
      await sendHTML("🔍 <b>Manual Screening Started</b>");
      return;
    }

    if (text === "/swap-all") {
      try {
        await sendHTML("🔄 <b>Sweeping all tokens to SOL...</b>");
        const result = await swapAllTokensToSol();
        if (result.success) {
          const count = result.swapped?.length || 0;
          if (count === 0) {
            await sendHTML("No eligible tokens found to swap.");
          } else {
            const symbols = result.swapped.map(s => s.input_mint?.slice(0, 4)).join(", ");
            await sendHTML(`✅ <b>Sweep Complete</b>\nSwapped ${count} tokens (<code>${escapeHTML(symbols)}</code>) to SOL.`);
          }
        } else {
          await sendHTML(`❌ Sweep failed: <code>${escapeHTML(result.error)}</code>`);
        }
      } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => { }); }
      return;
    }

    if (text === "/thresholds") {
      try {
        const s = config.screening;
        const m = config.management;
        const r = config.risk || config.management; // handles legacy/merged config
        const perf = getPerformanceSummary();
        
        let msg = "⚙️ *BOT CONFIGURATION*\n\n";

        // --- SCREENING SECTION ---
        let sc = "🔍 SCREENING\n";
        sc += "────────────────────\n";
        sc += `fee_aTVL_min    ${s.minFeeActiveTvlRatio}%\n`;
        sc += `organic_min     ${s.minOrganic}\n`;
        sc += `holders_min     ${s.minHolders}\n`;
        sc += `tvl_min         $${(s.minTvl/1000).toFixed(1)}k\n`;
        sc += `vol_min         $${(s.minVolume/1000).toFixed(1)}k\n`;
        sc += `mcap_min        $${(s.minMcap/1000).toFixed(1)}k\n`;
        sc += `mcap_max        $${(s.maxMcap/1000000).toFixed(1)}M\n`;
        sc += `age_min         ${s.minTokenAgeHours ?? 0}h\n`;
        sc += `timeframe       ${s.timeframe}\n`;
        msg += `\`\`\`\n${sc}\`\`\`\n`;

        // --- MANAGEMENT SECTION ---
        let mg = "💼 MANAGEMENT\n";
        mg += "────────────────────\n";
        mg += `deploy_amt      ${m.deployAmountSol} SOL\n`;
        mg += `max_pos         ${m.maxPositions}\n`;
        mg += `min_open        ${m.minSolToOpen} SOL\n`;
        mg += `gas_reserve     ${m.gasReserve} SOL\n`;
        mg += `strategy        ${m.strategy}\n`;
        msg += `\`\`\`\n${mg}\`\`\`\n`;

        // --- RISK & EXIT SECTION ---
        let rs = "🛡️ RISK & EXIT\n";
        rs += "────────────────────\n";
        rs += `stop_loss       ${m.stopLossPct}%\n`;
        rs += `tp_fee_pct      ${m.takeProfitFeePct}%\n`;
        rs += `trailing_tp     ${m.trailingTakeProfit ? "ON" : "OFF"}\n`;
        rs += `  trigger       ${m.trailingTriggerPct}%\n`;
        rs += `  drop          ${m.trailingDropPct}%\n`;
        rs += `oor_wait        ${m.outOfRangeWaitMinutes}m\n`;
        msg += `\`\`\`\n${rs}\`\`\`\n`;

        if (perf) {
          msg += `<i>Stats from ${perf.total_positions_closed} closed positions:</i>\n` +
                 `<b>Win Rate:</b> ${perf.win_rate_pct}%  •  <b>Avg PnL:</b> ${perf.avg_pnl_pct}%`;
        }

        await sendHTML(msg);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }
    if (text === "/positions") {
      try {
        const { positions, total_positions } = await getMyPositions({ force: true });
        if (total_positions === 0) { await sendMessage("No open positions."); return; }
        const cur = config.management.solMode ? "◎" : "$";
        
        let table = "#   Pair        Value   PnL     Fees\n";
        table += "──  ──────────  ──────  ──────  ──────\n";
        positions.forEach((p, i) => {
          const pair = p.pair.slice(0, 10).padEnd(10);
          const val = `${cur}${p.total_value_usd}`.slice(0, 6).padEnd(6);
          const pnl = `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`.slice(0, 6).padEnd(6);
          const fees = `${cur}${p.unclaimed_fees_usd}`.slice(0, 6).padEnd(6);
          const oor = !p.in_range ? " ⚠️" : "";
          table += `${String(i + 1).padEnd(2)}  ${pair}  ${val}  ${pnl}  ${fees}${oor}\n`;
        });

        await sendHTML(
          `<b>📊 Open Positions (${total_positions})</b>\n\n` +
          `<pre>${escapeHTML(table)}</pre>\n` +
          `<code>/close &lt;n&gt;</code> to close | <code>/set &lt;n&gt; &lt;note&gt;</code> to set instruction`
        );
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return; }
        const pos = positions[idx];
        await sendHTML(`Closing <b>${escapeHTML(pos.pair)}</b>...`);
        const result = await closePosition({ position_address: pos.position });
        if (result.success) {
          const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
          const claimNote = result.claim_txs?.length ? `\nClaim txs: <code>${escapeHTML(result.claim_txs.join(", "))}</code>` : "";
          await sendHTML(`✅ <b>Closed</b> ${escapeHTML(pos.pair)}\n<b>PnL:</b> ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"}  •  <b>txs:</b> <code>${escapeHTML(closeTxs?.join(", ") || "n/a")}</code>${claimNote}`);
        } else {
          await sendHTML(`❌ Close failed: <code>${escapeHTML(JSON.stringify(result))}</code>`);
        }
      } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => { }); }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, note);
        await sendHTML(`✅ Note set for <b>${escapeHTML(pos.pair)}</b>:\n"<i>${escapeHTML(note)}</i>"`);
      } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => { }); }
      return;
    }

    // ─── /teach lesson management ──────────────────────────────
    const teachMatch = text.match(/^\/teach\s+(.+)$/i);
    if (teachMatch) {
      try {
        const sub = teachMatch[1].trim();
        const { pinLesson, unpinLesson, rateLesson, getLearningStats, listLessons } = await import("./core/lessons.js");

        // /teach pin <id>
        const pinMatch = sub.match(/^pin\s+(.+)$/i);
        if (pinMatch) {
          const result = pinLesson(pinMatch[1].trim());
          if (result.found) {
            await sendHTML(`📌 Lesson pinned:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
          } else {
            await sendHTML(`Lesson <code>${escapeHTML(pinMatch[1])}</code> not found.`);
          }
          return;
        }

        // /teach unpin <id>
        const unpinMatch = sub.match(/^unpin\s+(.+)$/i);
        if (unpinMatch) {
          const result = unpinLesson(unpinMatch[1].trim());
          if (result.found) {
            await sendHTML(` Lesson unpinned:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
          } else {
            await sendHTML(`Lesson <code>${escapeHTML(unpinMatch[1])}</code> not found.`);
          }
          return;
        }

        // /teach rate <id> useful|useless
        const rateMatch = sub.match(/^rate\s+(\S+)\s+(useful|useless)$/i);
        if (rateMatch) {
          const result = rateLesson(rateMatch[1], rateMatch[2].toLowerCase());
          if (result.error) {
            await sendHTML(`<code>${escapeHTML(result.error)}</code>`);
          } else if (result.found) {
            const icon = result.rating === "useful" ? "👍" : "👎";
            await sendHTML(`${icon} Lesson rated as <b>${result.rating}</b>:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
          } else {
            await sendHTML(`Lesson <code>${escapeHTML(rateMatch[1])}</code> not found.`);
          }
          return;
        }

        // /teach stats
        if (/^stats$/i.test(sub)) {
          const stats = getLearningStats();
          let msg = `<b>Learning System Status</b>\n\n`;
          msg += `Closed positions: <b>${stats.performance_records}</b>\n`;
          msg += `Near-miss records: <b>${stats.near_misses}</b>\n`;
          msg += `Total lessons: <b>${stats.total_lessons}</b>\n`;
          msg += `Archived records: <b>${stats.archived_records}</b>\n`;
          if (stats.overall_win_rate != null) msg += `\nWin rate: <b>${stats.overall_win_rate}%</b>\n`;
          if (stats.total_pnl_usd != null) msg += `Total PnL: <b>$${stats.total_pnl_usd}</b>\n`;
          if (stats.avg_pnl_pct != null) msg += `Avg PnL: <b>${stats.avg_pnl_pct}%</b>\n`;
          if (stats.near_miss_avg_pnl_pct != null) msg += `Near-miss avg PnL: <b>${stats.near_miss_avg_pnl_pct}%</b>\n`;
          msg += `\nPinned: ${stats.pinned_lessons} | Useful: ${stats.rated_useful} | Useless: ${stats.rated_useless}\n`;
          msg += `Evolution cycles: ${stats.evolution_cycles}\n`;
          if (stats.current_thresholds && Object.keys(stats.current_thresholds).length > 0) {
            msg += `\n<b>Current thresholds:</b>\n`;
            msg += `maxBinStep: ${stats.current_thresholds.maxBinStep}\n`;
            msg += `minFeeActiveTvlRatio: ${stats.current_thresholds.minFeeActiveTvlRatio}\n`;
            msg += `minOrganic: ${stats.current_thresholds.minOrganic}`;
          }
          await sendHTML(msg);
          return;
        }

        // /teach list [role]
        if (/^list/i.test(sub)) {
          const roleArg = sub.split(/\s+/)[1]?.toUpperCase() || null;
          const result = listLessons({ role: roleArg, limit: 15 });
          if (result.total === 0) { await sendHTML("No lessons found."); return; }
          let msg = `<b>Lessons</b> (${result.total} total, showing ${result.lessons.length})\n\n`;
          for (const l of result.lessons) {
            const pinIcon = l.pinned ? "📌" : "";
            msg += `<code>${escapeHTML(l.id.slice(0, 8))}</code> ${pinIcon}[${l.outcome}] ${escapeHTML(l.rule.slice(0, 60))}\n`;
          }
          msg += `\n<i>Use /teach pin|rate|stats to manage</i>`;
          await sendHTML(msg);
          return;
        }

        await sendHTML(`<b>/teach</b> subcommands:\n<pre>  pin &lt;id&gt;       — pin a lesson\n  unpin &lt;id&gt;     — unpin a lesson\n  rate &lt;id&gt; useful|useless  — rate a lesson\n  stats          — learning system status\n  list [role]    — list lessons (optionally by role)</pre>`);
      } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => { }); }
      return;
    }

    busy = true;
    try {
      log("info", "telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, { requireTool: true });
      appendHistory(text, content);
      await sendHTML(`<pre>${escapeHTML(stripThink(content))}</pre>`);
    } catch (e) {
      await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => { });
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
      drainTelegramQueue().catch(() => {});
    }
  }

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /balance       Show detailed wallet holdings
  /candidates    Refresh top pool list
  /screen        Manually trigger a full screening cycle
  /swap-all      Sweep all non-SOL tokens in wallet back to SOL
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER",
          null,
          null,
          { requireTool: true }
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER",
          null,
          null,
          { requireTool: true }
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── screen: manual trigger ─────
    if (input.toLowerCase() === "screen" || input.toLowerCase() === "/screen") {
      runScreeningCycle().catch((e) => log("error", "cron", `Manual screening failed: ${e.message}`));
      console.log("\nManual screening cycle started.\n");
      rl.prompt();
      return;
    }

    // ── swap-all: manual sweep ─────
    if (input.toLowerCase() === "/swap-all") {
      await runBusy(async () => {
        console.log("\nSweeping wallet to SOL...\n");
        const result = await swapAllTokensToSol();
        if (result.success) {
          console.log(`\nSweep complete. Swapped ${result.swapped?.length || 0} tokens.\n`);
        } else {
          console.log(`\nSweep failed: ${result.error}\n`);
        }
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/balance") {
      await runBusy(async () => {
        const wallet = await getWalletBalances();
        console.log(`\nWallet Holdings ($${wallet.total_usd.toFixed(2)}):`);
        console.log(`  SOL:   ${wallet.sol.toFixed(4)} ($${wallet.sol_usd.toFixed(2)})`);
        for (const t of wallet.tokens) {
          if (t.symbol !== "SOL" && t.usd > 0.01) {
            console.log(`  ${t.symbol.padEnd(6)}: ${t.balance.toString().padEnd(12)} ($${t.usd.toFixed(2)})`);
          }
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const db = (await import("./core/db.js")).getDB();
        const allPerformance = db.prepare('SELECT * FROM performance').all();
        const result = evolveThresholds(allPerformance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("info", "user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { requireTool: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("info", "startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("error", "startup", e.message);
    }
  })();
}
