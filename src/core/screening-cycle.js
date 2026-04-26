/**
 * Screening cycle — discovers candidates, applies filters and simulations,
 * calls LLM (via agentGateway) to decide on deployments.
 */

import { log } from "./logger.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { getTopCandidates } from "../screening/discovery.js";
import { getActiveBin } from "../integrations/meteora.js";
import { config, computeDeployAmount, isDryRun } from "../config.js";
import {
  timers,
  _busyState,
  _timersState,
} from "./state/scheduler-state.js";
import { checkDailyCircuitBreaker, getDailyPnL } from "./daily-tracker.js";
import { captureAlert } from "../instrument.js";
import { getActiveStrategy } from "./strategy-library.js";
import { detectMarketPhase as _detectMarketPhase, PHASE_CONFIG } from "./phases.js";
import { findStrategiesForPhase } from "./lparmy-strategies.js";
import { simulatePoolDeploy } from "./simulator.js";
import { isEnabled as telegramEnabled, sendHTML } from "../notifications/telegram.js";
import {
  fetchAndReconCandidates,
  applyHardFilters,
  buildCandidateBlocks,
} from "./screening-helpers.js";
import { isFlagEnabled } from "./feature-flags.js";
import { isTokenSafe } from "../features/token-security.js";
import { defaultGateway as agentGateway } from "./agent-gateway.js";
import { getSharedLessonsForPrompt } from "../features/hive-mind.js";
import { recordDecision } from "./decision-log.js";
import { escapeHTMLLocal } from "./cycle-helpers.js";

/**
 * Format a clean Telegram notification from screening results.
 * Shows candidates, hard-filter pass/fail, and the final decision.
 * Overrides DEPLOYED text when toolFailed === "deploy_position" to prevent
 * hallucinated success notifications from propagating to Telegram.
 */
function formatScreeningNotification(screenReport, passing, activeBinResults, simulations, deployAmount, toolFailed = null, partialResult = null) {
  // Override hallucinated DEPLOYED text when deploy_position actually failed on-chain
  let report = screenReport;
  if (toolFailed === "deploy_position" && partialResult?.result) {
    const r = partialResult.result;
    const poolName = r.pool_name || r.pool || "unknown";
    const errorMsg = r.error || "unknown";
    log("warn", "screening", `deploy_position returned success=false — overriding notification: ${errorMsg}`);
    report = `*Decision:* NO DEPLOY\n*analysis:* Deploy to ${poolName} failed on-chain. Error: ${errorMsg}. No position was opened.\n*rejected:* deploy tool returned { success: false, error: ${errorMsg}}`;
  }

  const lines = [];
  lines.push("🔍 <b>Screening Results</b>");

  // ── Candidates passed hard filters ──────────────────────────────────
  lines.push(`\n📋 <b>Candidates:</b> ${passing.length} passed hard filters`);
  for (let i = 0; i < passing.length; i++) {
    const { pool, score, indicators } = passing[i];
    const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
    const sim = simulations[i];
    const rsiMatch = indicators?.match(/RSI=(\d+)/);
    const rsiStr = rsiMatch ? ` RSI=${rsiMatch[1]}` : "";

    const decisionMatch = report.match(/\*Decision:\*\s*(\S+)/);
    const decision = decisionMatch ? decisionMatch[1] : null;
    const emoji = decision === "NO" ? "➖" : sim.passes ? "✅" : "⚠️";
    lines.push(`${emoji} <code>${pool.name}</code> | fee_tvl=${pool.fee_active_tvl_ratio} | vol=$${pool.volume_window} | tvl=$${pool.active_tvl} | mcap=$${pool.mcap} | organic=${pool.organic_score}${rsiStr} | score=${score.score}/${score.max} (${score.label}) | sim: passes=${sim.passes ? "YES" : "NO"} (risk=${sim.risk_score}, conf=${sim.confidence})${activeBin != null ? ` | bin=${activeBin}` : ""}`);
  }

  // ── Hard filter summary ─────────────────────────────────────────────
  lines.push(`\n💰 Deploy amount: ${deployAmount} SOL`);

  // ── Decision block ───────────────────────────────────────────────────
  if (/DEPLOYED/i.test(report)) {
    const poolMatch = report.match(/\*pool:\*\s*([^\s*]+)\s*\|?\s*([^\n*]+)/);
    const amountMatch = report.match(/\*amount:\*\s*([^\n*]+)/);
    const stratMatch = report.match(/strategy[*=]([^\s\n*]+)/);
    const simMatch = report.match(/sim:\s*[^\n]+\|?\s*(risk=\d+\/100)?\s*[,]?\s*(confidence=\d+\/100)?/);
    const reasonMatch = report.match(/\*reason:\*\s*([^\n]+)/);

    lines.push(`\n✅ <b>DEPLOYED</b>`);
    if (poolMatch) lines.push(`Pool: ${escapeHTMLLocal(poolMatch[1].trim())} | ${escapeHTMLLocal(poolMatch[2].trim())}`);
    if (amountMatch) lines.push(`Amount: ${escapeHTMLLocal(amountMatch[1].trim())}`);
    if (stratMatch) lines.push(`Strategy: ${escapeHTMLLocal(stratMatch[1])}`);
    if (simMatch && (simMatch[1] || simMatch[2])) {
      const parts = [];
      if (simMatch[1]) parts.push(simMatch[1]);
      if (simMatch[2]) parts.push(simMatch[2]);
      lines.push(`Simulation: ${parts.join(", ")}`);
    }
    if (reasonMatch) lines.push(`Why: ${escapeHTMLLocal(reasonMatch[1].trim())}`);
  } else {
    const analysisMatch = report.match(/\*analysis:\*\s*([^\n]+(?:\n[^\n]+)?)/);
    const rejectedMatch = report.match(/\*rejected:\*\s*([^\n]+)/);
    lines.push(`\n➖ <b>NO DEPLOY</b>`);
    if (analysisMatch) lines.push(`${escapeHTMLLocal(analysisMatch[1].trim())}`);
    if (rejectedMatch) lines.push(`Rejected: ${escapeHTMLLocal(rejectedMatch[1].trim())}`);
  }

  return lines.join("\n");
}

export async function runScreeningCycle({ silent = false, gateway = agentGateway } = {}) {
  if (_busyState._screeningBusy) {
    log("info", "screening", "Screening skipped — previous cycle still running");
    return null;
  }
  _busyState._screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _timersState.screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    // Always fetch fresh balance for screening decisions — stale cache could cause
    // deploy to be approved against a balance that's already committed in a pending tx
    const { invalidateBalanceCache } = await import("../integrations/helius.js");
    invalidateBalanceCache();
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("debug", "cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      _busyState._screeningBusy = false;
      return null;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired && !isDryRun()) {
      log("debug", "cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      _busyState._screeningBusy = false;
      return null;
    }
    if (preBalance.sol < minRequired && isDryRun()) {
      log("info", "cron", `DRY RUN — bypassing SOL check (${preBalance.sol.toFixed(3)} SOL, would need ${minRequired})`);
    }
  } catch (e) {
    log("error", "cron", `Screening pre-check failed: ${e.message}`);
    _busyState._screeningBusy = false;
    return null;
  }
  timers.screeningLastRun = Date.now();
  log("debug", "cron", `Starting screening cycle`);
  let screenReport = null;
  let canDeploy = true; // circuit breaker may block new deployments
  let screeningMode = "normal";
  // Variables needed in finally block for notification formatting
  let passing = [];
  let activeBinResults = [];
  let simulations = [];
  let deployAmount = 0;
  let toolFailed = null;
  let partialResult = null;

  // Daily PnL circuit breaker
  const pnl = await getDailyPnL();
  const circuit = await checkDailyCircuitBreaker();
  log("info", "daily-pnl", `Screening circuit: ${circuit.action} (realized: $${(pnl.realized || 0).toFixed(2)}, reason: ${circuit.reason || "normal"})`);
  if (circuit.action === "halt") {
    log("warn", "daily-pnl", `CIRCUIT BREAKER (screening): daily loss limit hit — skipping screening entirely`);
    captureAlert(`CIRCUIT BREAKER HALT (screening): daily loss limit hit — screening skipped`);
    _busyState._screeningBusy = false;
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
    deployAmount = deployAmountResult.amount || 0;
    log("debug", "cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL, positions: ${prePositions.total_positions || 0})`);

    // Load active strategy (phase info injected later after candidate recon)
    const activeStrategy = await getActiveStrategy();

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const candStart = Date.now();
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(e => { log("warn", "screening", `getTopCandidates failed: ${e?.message ?? e}`); return null; });
    log("info", "cron", `[TIMING] getTopCandidates: ${Date.now() - candStart}ms`);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    const reconStart = Date.now();
    const allCandidates = await fetchAndReconCandidates(candidates);
    log("info", "cron", `[TIMING] fetchAndReconCandidates: ${Date.now() - reconStart}ms`);

    // Pre-deploy token security gate — skip candidates with unsafe tokens
    if (isFlagEnabled("token_security_enabled")) {
      const securityStart = Date.now();
      const securityChecked = [];
      for (const c of allCandidates) {
        const mint = c.pool.base?.mint;
        if (!mint) { securityChecked.push(c); continue; }
        const { safe, reason } = await isTokenSafe(mint);
        if (!safe) {
          log("warn", "token-security", `Skipping ${c.pool.name} — token unsafe: ${reason}`);
        } else {
          securityChecked.push(c);
        }
      }
      // Replace allCandidates with the filtered list
      allCandidates.length = 0;
      allCandidates.push(...securityChecked);
      log("info", "cron", `[TIMING] token security check: ${Date.now() - securityStart}ms`);
    }

    // Hard filters after token recon — block launchpads, excessive bots, and toxic tokens
    passing = applyHardFilters(allCandidates, config, prePositions);

    if (passing.length === 0) {
      screenReport = `No candidates available (all blocked by launchpad filter).`;
      try {
        recordDecision({
          type: "skip",
          pool: null,
          position: null,
          amount: null,
          pnl: null,
          reasoning: "no candidates qualified",
          metadata: { initiated_by: "rule" },
        }).catch(e => log("warn", "decision-log", `Failed to record skip decision: ${e?.message ?? String(e)}`));
      } catch (e) {
        log("warn", "decision-log", `Failed to record skip decision: ${e?.message ?? String(e)}`);
      }
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    activeBinResults = await Promise.allSettled(
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
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? "config-default"} | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}\n${phaseBlock}`
      : `No active strategy — use default bid_ask, bins_above: ${config.strategy.binsAbove} (from config), SOL only.\n${phaseBlock}`;

    // Run simulator for all passing candidates
    simulations = passing.map(({ pool }) => simulatePoolDeploy(pool, deployAmount, preBalance.usd ?? 0));

    // Build compact candidate blocks
    const candidateBlocks = buildCandidateBlocks(passing, activeBinResults, simulations);

    // ── Hive Mind lessons for prompt injection ─────────────────────────
    const hiveLessonsBlock = getSharedLessonsForPrompt({ agentType: "SCREENER", maxLessons: 6 });

    // ── Call LLM via agentGateway ─────────────────────────────────────
    const gatewayResult = await gateway.runScreeningCycle({
      candidateBlocks,
      passingCount: passing.length,
      currentBalance,
      preBalance,
      prePositions,
      strategyBlock,
      deployAmount,
      pnl,
      canDeploy,
      hiveLessonsBlock,
      screeningMode,
    });
    const content = gatewayResult.content;
    partialResult = gatewayResult.partialResult;
    toolFailed = gatewayResult.toolFailed;

    // Override hallucinated DEPLOYED text with actual on-chain result.
    // If deploy_position was called but returned success=false, the LLM may have
    // written "*Decision:* DEPLOYED PAIR" anyway — detect this and report真实失败.
    if (toolFailed === "deploy_position" && partialResult?.result) {
      const r = partialResult.result;
      const poolName = r.pool_name || r.pool || "unknown";
      log("warn", "screening", `deploy_position returned success=false — overriding LLM text: ${r.error}`);
      screenReport = `*Decision:* NO DEPLOY\n*analysis:* Deploy to ${poolName} failed on-chain. Error: ${r.error || "unknown"}. No position was opened.\n*rejected:* deploy tool returned { success: false, error: ${r.error || "unknown" }}`;
    } else {
      screenReport = content;
    }
  } catch (error) {
    log("error", "cron", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _busyState._screeningBusy = false;
    if (!silent && telegramEnabled()) {
      // Send notification for both successful deploys AND failed deploy attempts
      // (toolFailed check needed because failed deploys override screenReport to "NO DEPLOY")
      if (screenReport && (/DEPLOYED/i.test(screenReport) || toolFailed === "deploy_position")) {
        const html = formatScreeningNotification(screenReport, passing, activeBinResults, simulations, deployAmount, toolFailed, partialResult);
        sendHTML(html).catch(() => { });
      }
    }
  }
  return screenReport;
}
