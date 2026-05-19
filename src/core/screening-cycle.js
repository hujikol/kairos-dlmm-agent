/**
 * Screening cycle — discovers candidates, applies filters and simulations,
 * calls LLM (via agentGateway) to decide on deployments.
 */

import { log } from "./logger.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { getTopCandidates } from "../screening/discovery.js";
import { getActiveBin } from "../integrations/meteora.js";
import { isEnabled as telegramEnabled, sendHTML, notifyDeploy, drainTelegramQueue } from "../notifications/telegram.js";
import { captureAlert } from "../instrument.js";
import { config, computeDeployAmount, isDryRun } from "../config.js";
import { getDB } from "./db.js";
import {
  timers,
  _busyState,
  _timersState,
} from "./state/scheduler-state.js";
import { checkDailyCircuitBreaker, getDailyPnL } from "./daily-tracker.js";
import { getActiveStrategy } from "./strategy-library.js";
import { detectMarketPhase, PHASE_CONFIG } from "./phases.js";
import { findStrategiesForPhase } from "./lparmy-strategies.js";
import { simulatePoolDeploy } from "./simulator.js";
import { stripThink } from "../tools/caveman.js";
import {
  fetchAndReconCandidates,
  applyHardFilters,
  buildCandidateBlocks,
} from "./screening-helpers.js";
import { defaultGateway as agentGateway } from "./agent-gateway.js";
import { getSharedLessonsForPrompt, getSharedPresetsForPrompt } from "../features/hive-mind.js";
import { recordDecision, getDecisionSummary } from "./decision-log.js";
import { startCycleOutcome, updateCycleOutcome, recordDeployConfirmed, finalizeCycleOutcome } from "./cycle-outcome.js";
import { isToxicPool, markPoolAsRug } from "./toxic-pool-filter.js";
import { recordHallucination, recordDeployFailure } from "./safe-mode.js";

export async function runScreeningCycle({ silent = false, gateway = agentGateway } = {}) {
  if (_busyState._screeningBusy) {
    log("info", "screening", "Screening skipped — previous cycle still running");
    return null;
  }
  _busyState._screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _timersState.screeningLastTriggered = Date.now();
  const cycleId = startCycleOutcome("screening");

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("debug", "cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      _busyState._screeningBusy = false;
      drainTelegramQueue();
      return null;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired && !isDryRun()) {
      log("debug", "cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      _busyState._screeningBusy = false;
      drainTelegramQueue();
      return null;
    }
    if (preBalance.sol < minRequired && isDryRun()) {
      log("info", "cron", `DRY RUN — bypassing SOL check (${preBalance.sol.toFixed(3)} SOL, would need ${minRequired})`);
    }
  } catch (e) {
    log("error", "cron", `Screening pre-check failed: ${e?.message ?? String(e)}`);
    _busyState._screeningBusy = false;
    drainTelegramQueue().catch(() => {});
    return null;
  }
  timers.screeningLastRun = Date.now();
  log("debug", "cron", `Starting screening cycle`);
  let screenReport = null;
  let canDeploy = true; // circuit breaker may block new deployments
  let screeningMode = "normal";

  // Daily PnL circuit breaker
  const pnl = await getDailyPnL();
  const circuit = await checkDailyCircuitBreaker({ positions: prePositions?.positions ?? null });
  log("info", "daily-pnl", `Screening circuit: ${circuit.action} (realized: $${(pnl.realized || 0).toFixed(2)}, reason: ${circuit.reason || "normal"})`);
  if (circuit.action === "halt") {
    log("warn", "daily-pnl", `CIRCUIT BREAKER (screening): daily loss limit hit — skipping screening entirely`);
    captureAlert(`CIRCUIT BREAKER HALT (screening): daily loss limit hit — screening skipped`);
    _busyState._screeningBusy = false;
    drainTelegramQueue();
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
    let topCandidates = null;
    try {
      topCandidates = await getTopCandidates({ limit: 10 });
    } catch (e) {
      log("warn", "screening", `getTopCandidates failed on first attempt: ${e?.message ?? e}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        topCandidates = await getTopCandidates({ limit: 10 });
      } catch (retryErr) {
        log("error", "screening", `getTopCandidates failed after retry: ${retryErr?.message ?? retryErr}`);
        sendHTML(
          `<b>⚠️ Screening Degraded</b>\n\nPool discovery API unavailable after retries. Manual review recommended.`
        ).catch(() => {});
      }
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    const allCandidates = await fetchAndReconCandidates(candidates).catch(e => {
      log("error", "screening", `fetchAndReconCandidates failed: ${e?.message ?? String(e)} — aborting cycle`);
      return [];
    });

    // Hard filters after token recon — block launchpads, excessive bots, and toxic tokens
    const passing = applyHardFilters(allCandidates, config, prePositions);

    const nonToxicCandidates = passing.filter(c => {
      if (isToxicPool(c.pool_address)) {
        log("debug", "screening", `Pool ${c.pool_address} blocked — toxic memory`);
        return false;
      }
      return true;
    });

    updateCycleOutcome(cycleId, { candidates_seen: allCandidates.length, filters_passed: nonToxicCandidates.length, llm_calls: 1 });

    if (nonToxicCandidates.length === 0) {
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
      nonToxicCandidates.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Determine dominant market phase (most common among passing candidates)
    const phaseCounts = {};
    for (const c of nonToxicCandidates) { phaseCounts[c.phase] = (phaseCounts[c.phase] || 0) + 1; }
    const dominantPhase = Object.entries(phaseCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "normal";
    const phaseMeta = PHASE_CONFIG[dominantPhase];
    const phaseStrategies = findStrategiesForPhase(dominantPhase, 5);

    const phaseMultiplier = PHASE_CONFIG[dominantPhase]?.rangeMultiplier ?? 1.0;
    const baseBinsAbove = activeStrategy?.range?.bins_above ?? config.strategy.binsAbove;
    const adjustedBinsAbove = Math.round(baseBinsAbove * phaseMultiplier);
    const phaseAdjustedRange = `phase=${dominantPhase}, adjusted_bins_above=${adjustedBinsAbove} (\u00d7${phaseMultiplier})`;

    // Build the strategy + phase prompt block (requires dominantPhase from candidates)
    const strategyNames = phaseStrategies.map(s => s.name).join(", ");
    const phaseBlock = `MARKET PHASE: ${dominantPhase} — ${phaseMeta.description}\nPhase-matched strategies: ${strategyNames}\nToken scores are included per candidate — prefer GOOD or EXCELLENT tokens.`;
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? "config-default"} | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}\nPHASE RANGE ADJUSTMENT: ${phaseAdjustedRange}\n${phaseBlock}`
      : `No active strategy — use default bid_ask, bins_above: ${config.strategy.binsAbove} (from config), SOL only.\nPHASE RANGE ADJUSTMENT: ${phaseAdjustedRange}\n${phaseBlock}`;

    // Run simulator for all non-toxic candidates — parallel with active bin fetch since both are independent
    const simulations = await Promise.all(
      nonToxicCandidates.map(({ pool }) => simulatePoolDeploy(pool, deployAmount, preBalance.usd ?? 0))
    );

    const MIN_RISK_SCORE = 40;
    const MIN_CONFIDENCE = 40;

    const qualityCandidates = nonToxicCandidates.map((c, i) => ({ ...c, simulation: simulations[i] }))
      .filter(c => (c.simulation?.risk_score ?? 100) <= MIN_RISK_SCORE
                 && (c.simulation?.confidence ?? 0) >= MIN_CONFIDENCE);

    if (qualityCandidates.length === 0) {
      log("info", "screening", `No candidates met quality floor (risk_score<=${MIN_RISK_SCORE}, confidence>=${MIN_CONFIDENCE})`);
      finalizeCycleOutcome(cycleId);
      if (!silent && telegramEnabled()) {
        sendHTML(`<b>🔍 Screening Cycle</b>\n\nNo candidates met minimum quality thresholds. Screening skipped.`);
      }
      return null;
    }

    // Build compact candidate blocks
    const candidateBlocks = buildCandidateBlocks(qualityCandidates, activeBinResults, simulations);

    // ── Hive Mind lessons for prompt injection ─────────────────────────
    const hiveLessonsBlock = getSharedLessonsForPrompt({ agentType: "SCREENER", maxLessons: 6 });
    const hivePresetsBlock = getSharedPresetsForPrompt({ agentType: "SCREENER", maxPresets: 4 });

    // ── Decision summary for prompt injection ──────────────────────────
    const decisionSummary = await getDecisionSummary({ limit: 6 });

    // ── Call LLM via agentGateway ─────────────────────────────────────
    const { content } = await gateway.runScreeningCycle({
      candidateBlocks,
      passingCount: qualityCandidates.length,
      currentBalance,
      preBalance,
      prePositions,
      strategyBlock,
      deployAmount,
      pnl,
      canDeploy,
      hiveLessonsBlock,
      hivePresetsBlock,
      screeningMode,
      decisionSummary,
    });
    screenReport = content;

    const db = getDB();
    const cycleTimestamp = Date.now();
    const deployedPoolAddr = deployed?.pool_address || null;
    const insertStmt = db.prepare(`
      INSERT INTO rejected_candidates (cycle_timestamp, pool_address, pool_name, simulator_score, reason_rejected, llm_mentioned)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const c of qualityCandidates) {
      const wasSelected = c.pool_address === deployedPoolAddr;
      insertStmt.run(
        cycleTimestamp,
        c.pool_address,
        c.pool_name || c.token_symbol || c.token_name || "unknown",
        c.simulation?.risk_score ?? null,
        wasSelected ? "selected" : "not_selected",
        wasSelected ? 1 : 0
      );
    }
  } catch (error) {
    log("error", "cron", `Screening cycle failed: ${error?.message ?? String(error)}`);
    screenReport = `Screening cycle failed: ${error?.message ?? String(error)}`;
  } finally {
    _busyState._screeningBusy = false;
    try { finalizeCycleOutcome(cycleId); } catch (e) { log("warn", "screening", `finalizeCycleOutcome failed: ${e?.message ?? String(e)}`); }
    if (typeof drainTelegramQueue === "function") {
      drainTelegramQueue().catch(e => log("warn", "screening", `drainTelegramQueue failed: ${e?.message ?? String(e)}`));
    } else {
      log("warn", "screening", "drainTelegramQueue not available — skipping");
    }

    if (!silent && telegramEnabled()) {
      // ── On-chain verification before notification ─────────────────────────────
      // Diff positions before/after the LLM run to determine what actually happened.
      // Only send deploy notifications when a real on-chain position exists.
      const postPositions = await getMyPositions({ force: true }).catch(err => {
        log("warn", "screening", `Post-cycle position fetch failed: ${err?.message ?? String(err)} — skipping deploy verification`);
        return null;
      });
      const deployed = detectNewlyDeployedPosition(prePositions, postPositions);

      if (deployed) {
        // ✅ Deployment confirmed on-chain — send structured notification
        log("info", "screening", `Deploy confirmed on-chain: ${deployed.pool_name} (${deployed.position})`);
        recordDeployConfirmed(cycleId, deployed.position);
        notifyDeploy({
          pair: deployed.pool_name || deployed.pair,
          amountSol: deployed.amount_sol || deployAmount,
          position: deployed.position,
          tx: deployed.tx_signature || null,
          priceRange: deployed.min_price != null && deployed.max_price != null
            ? { min: deployed.min_price, max: deployed.max_price }
            : null,
          binStep: deployed.bin_step || null,
          baseFee: deployed.fee_tvl_ratio || null,
        }).catch(e => log("error", "telegram", `notifyDeploy failed: ${e?.message ?? String(e)}`));
      } else if (/DEPLOYED/i.test(screenReport)) {
        // ⚠️ LLM claimed DEPLOYED but nothing on-chain — hallucination or tx failure
        log("warn", "screening", `Deploy not confirmed on-chain — potential tx failure or hallucination`);
        captureAlert(`Deploy not confirmed on-chain after LLM reported DEPLOYED. Screen report: ${String(screenReport).slice(0, 300)}`);
        recordHallucination();
        if (deployed?.pool_address) {
          markPoolAsRug(deployed.pool_address);
          recordDeployFailure();
        }
        sendHTML(
          `<b>⚠️ Screening Complete — No Deployment</b>\n` +
          `LLM reported a deployment but none was found on-chain.\n` +
          `This may indicate the deploy was rejected by safety checks or the LLM hallucinated.\n` +
          `Manual review recommended.`
        ).catch(() => {});
      } else if (screenReport) {
        // Normal NO-DEPLOY cycle — send the report
        sendHTML(`<b>🔍 Screening Cycle</b>\n\n<pre>${stripThink(screenReport)}</pre>`).catch(() => {});
      }
    }
  }
  return screenReport;
}

/**
 * Detect a newly deployed position by diffing positions before and after the LLM run.
 * Returns the new position object if one was opened, or null otherwise.
 */
function detectNewlyDeployedPosition(before, after) {
  if (!before || !after) return null;
  const beforeAddrs = new Set((before.positions || []).map(p => p.position));
  const newPositions = (after.positions || []).filter(p => {
    return !beforeAddrs.has(p.position) && !p.closed;
  });
  if (newPositions.length === 0) return null;
  // Return the most recently created one
  return newPositions.sort((a, b) =>
    new Date(b.deployed_at || b.created_at || 0) - new Date(a.deployed_at || a.created_at || 0)
  )[0];
}
