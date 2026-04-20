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
import { detectMarketPhase, PHASE_CONFIG } from "./phases.js";
import { findStrategiesForPhase } from "./lparmy-strategies.js";
import { simulatePoolDeploy } from "./simulator.js";
import { isEnabled as telegramEnabled, sendHTML } from "../notifications/telegram.js";
import { stripThink } from "../tools/caveman.js";
import {
  fetchAndReconCandidates,
  applyHardFilters,
  buildCandidateBlocks,
} from "./screening-helpers.js";
import { defaultGateway as agentGateway } from "./agent-gateway.js";
import { getSharedLessonsForPrompt } from "../features/hive-mind.js";
import { recordDecision } from "./decision-log.js";

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
    const deployAmount = deployAmountResult.amount || 0;
    log("debug", "cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL, positions: ${prePositions.total_positions || 0})`);

    // Load active strategy (phase info injected later after candidate recon)
    const activeStrategy = await getActiveStrategy();

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(e => { log("warn", "screening", `getTopCandidates failed: ${e?.message ?? e}`); return null; });
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    const allCandidates = await fetchAndReconCandidates(candidates);

    // Hard filters after token recon — block launchpads, excessive bots, and toxic tokens
    const passing = applyHardFilters(allCandidates, config, prePositions);

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
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? "config-default"} | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}\n${phaseBlock}`
      : `No active strategy — use default bid_ask, bins_above: ${config.strategy.binsAbove} (from config), SOL only.\n${phaseBlock}`;

    // Run simulator for all passing candidates
    const simulations = passing.map(({ pool }) => simulatePoolDeploy(pool, deployAmount, preBalance.usd ?? 0));

    // Build compact candidate blocks
    const candidateBlocks = buildCandidateBlocks(passing, activeBinResults, simulations);

    // ── Hive Mind lessons for prompt injection ─────────────────────────
    const hiveLessonsBlock = getSharedLessonsForPrompt({ agentType: "SCREENER", maxLessons: 6 });

    // ── Call LLM via agentGateway ─────────────────────────────────────
    const { content } = await gateway.runScreeningCycle({
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
    screenReport = content;
  } catch (error) {
    log("error", "cron", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _busyState._screeningBusy = false;
    if (!silent && telegramEnabled()) {
      // Only send if agent actually deployed a position (action taken)
      if (screenReport && /DEPLOYED/i.test(screenReport)) {
        const { escapeHTMLLocal } = await import("./cycle-helpers.js");
        sendHTML(`<b>🔍 Screening Cycle</b>\n\n<pre>${escapeHTMLLocal(stripThink(screenReport))}</pre>`).catch(() => { });
      }
    }
  }
  return screenReport;
}
