/**
 * Management cycle — monitors open positions, applies deterministic rules,
 * calls LLM (via agentGateway) when action is needed.
 */

import { log } from "./logger.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { config, computeDeployAmount, isDryRun } from "../config.js";
import {
  timers,
  _busyState,
  _timersState,
} from "./state/scheduler-state.js";
import { checkDailyCircuitBreaker, getDailyPnL } from "./daily-tracker.js";
import { captureAlert } from "../instrument.js";
import { getTrackedPosition } from "./state/registry.js";
import { updatePnlAndCheckExits } from "./state/pnl.js";
import { getStreak, incrementStreak, resetStreak } from "./state/index.js";
import { recordPositionSnapshot, recallForPool } from "../features/pool-memory.js";
import { pushNotification, hasPendingNotifications } from "../notifications/queue.js";
import { isEnabled as telegramIsEnabled, drainTelegramQueue } from "../notifications/telegram.js";
import {
  computeManagementActions,
  buildManagementReport,
  autoSwapAndNotify,
  buildAndSendConsolidatedReport,
} from "./management-helpers.js";
import { SCREENING_COOLDOWN_MS } from "./constants.js";
import { defaultGateway as agentGateway } from "./agent-gateway.js";

export async function runManagementCycle({ silent = false, gateway = agentGateway } = {}) {
  const cycleStart = Date.now();
  if (_busyState._managementBusy) return null;
  _busyState._managementBusy = true;
  timers.managementLastRun = Date.now();
  log("debug", "cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];

  try {
    // Daily PnL circuit breaker
    const pnl = await getDailyPnL();
    const circuit = await checkDailyCircuitBreaker();
    log("info", "daily-pnl", `Circuit breaker: ${circuit.action} (realized: ${pnl.realized?.toFixed(2) ?? "N/A"} USD, reason: ${circuit.reason || "normal"})`);
    if (circuit.action === "halt") {
      log("warn", "daily-pnl", `CIRCUIT BREAKER: daily loss limit hit — skipping new deployments this cycle`);
      captureAlert(`CIRCUIT BREAKER HALT: daily loss limit hit (realized PnL: ${pnl.realized?.toFixed(2) ?? "N/A"} USD)`);
      // Still manage existing positions (close/claim) in halt mode
    }

    const posStart = Date.now();
    const [livePositions, currentBalance] = await Promise.all([
      getMyPositions({ force: true }).catch(e => { log("warn", "cron", `getMyPositions failed: ${e?.message ?? e}`); return null; }),
      getWalletBalances(),
    ]);
    log("info", "cron", `[TIMING] getMyPositions + getWalletBalances: ${Date.now() - posStart}ms`);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("debug", "cron", "No open positions — triggering screening cycle");
      import("./screening-cycle.js").then(({ runScreeningCycle }) => {
        if (runScreeningCycle) {
          const p = runScreeningCycle();
          if (p && typeof p.catch === "function") {
            p.catch((e) => { log("error", "cron", `Triggered screening failed: ${e?.message ?? e}`); });
          }
        } else {
          log("error", "cron", "Screening cycle module missing runScreeningCycle export");
        }
      }).catch(e => log("error", "cron", `Failed to load screening cycle: ${e?.message ?? e}`));
      return null;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check and Loss Streak Tracking
    const exitMap = new Map();
    for (const p of positionData) {
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("info", "state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }

      // Loss Streak tracking
      const isOOR = !p.in_range;
      const isNegative = (p.pnl_pct ?? 0) < config.management.lossStreakMinPnlPct;

      if (!isOOR && isNegative) {
        incrementStreak(p.position);
        log("debug", "loss-streak", `${p.pair}: streak ${getStreak(p.position)}`);
      } else {
        resetStreak(p.position);
      }
    }

    // ── Deterministic rule engine ─────────────────────────────────────
    const actionMap = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    // ── Build JS report ──────────────────────────────────────────────
    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    mgmtReport = buildManagementReport(positionData, actionMap, positions, config);

    // ── Execute deterministic CLOSE/CLAIM directly (no LLM) ─────────
    const closeActions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a?.action === "CLOSE";
    });
    const claimActions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a?.action === "CLAIM";
    });
    const instructionActions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a?.action === "INSTRUCTION";
    });

    // Direct close execution — bypasses LLM entirely
    const { closePosition, claimFees } = await import("../integrations/meteora/close.js");
    const closeResults = [];
    for (const p of closeActions) {
      const act = actionMap.get(p.position);
      const reason = act.reason || "agent decision";
      log("info", "cron", `Direct CLOSE: ${p.pair} (${p.position}) — ${reason}`);
      try {
        const result = await closePosition({ position_address: p.position, reason });
        closeResults.push({ position: p, result, reason });
        if (result.success !== false) {
          pushNotification({
            type: "close",
            pair: p.pair,
            pnlUsd: result.pnl_usd ?? p.pnl_usd ?? 0,
            pnlPct: result.pnl_pct ?? p.pnl_pct ?? 0,
            reason,
          });
          mgmtReport += `\n✅ Closed ${p.pair}: ${reason} (PnL: ${result.pnl_pct ?? p.pnl_pct ?? "?"}%)`;
        } else {
          log("error", "cron", `Direct CLOSE failed for ${p.pair}: ${result.error}`);
          mgmtReport += `\n❌ Close failed ${p.pair}: ${result.error}`;
        }
      } catch (e) {
        const errMsg = e?.message ?? String(e);
        log("error", "cron", `Direct CLOSE error for ${p.pair}: ${errMsg}`);
        mgmtReport += `\n❌ Close error ${p.pair}: ${errMsg}`;
      }
    }

    // Direct claim execution — bypasses LLM entirely
    for (const p of claimActions) {
      log("info", "cron", `Direct CLAIM: ${p.pair} (${p.position})`);
      try {
        const result = await claimFees({ position_address: p.position });
        if (result.success !== false) {
          pushNotification({
            type: "claim",
            pair: p.pair,
            usd: p.unclaimed_fees_usd ?? 0,
          });
          mgmtReport += `\n💰 Claimed fees ${p.pair}: $${(p.unclaimed_fees_usd ?? 0).toFixed(2)}`;
        } else {
          log("warn", "cron", `Direct CLAIM failed for ${p.pair}: ${result.error}`);
        }
      } catch (e) {
        const errMsg = e?.message ?? String(e);
        log("error", "cron", `Direct CLAIM error for ${p.pair}: ${errMsg}`);
      }
    }

    // Only INSTRUCTION actions go to LLM (require interpretation)
    if (instructionActions.length > 0) {
      log("debug", "cron", `Management: ${instructionActions.length} INSTRUCTION action(s) — invoking LLM`);

      const cur = config.management.solMode ? "◎" : "$";
      const actionBlocks = instructionActions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: INSTRUCTION`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          `  instruction: "${p.instruction}"`,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await gateway.runManagementCycle({
        actionBlocks,
        actionPositions: instructionActions,
        currentBalance,
        livePositions,
      });

      mgmtReport += `\n\n${content}`;
    } else if (closeActions.length === 0 && claimActions.length === 0) {
      log("debug", "cron", "Management: all positions STAY — skipping");
    }

    // ═══════════════════════════════════════════
    //  POST-TRADE: Auto-swap fee tokens to SOL
    // ═══════════════════════════════════════════
    const executedActions = [...closeActions, ...claimActions];
    await autoSwapAndNotify(executedActions);

    // Trigger screening after management if we expect to be under max positions
    // Skip if circuit breaker is in halt mode
    const closesAttempted = needsAction.filter(a => a.action === "CLOSE" || a.action === "INSTRUCTION").length;
    const afterCount = Math.max(0, positions.length - closesAttempted);
    const lastTriggeredAt = _timersState.screeningLastTriggered;

    if (afterCount < config.risk.maxPositions && Date.now() - lastTriggeredAt > SCREENING_COOLDOWN_MS && circuit.action !== "halt") {
      if (_busyState._screeningBusy) return;
      _busyState._screeningBusy = true;
      import("./screening-cycle.js").then(({ runScreeningCycle }) => {
        // Re-check to avoid race: if another call set _timersState.screeningLastTriggered while we were waiting for the lock
        if (_timersState.screeningLastTriggered !== lastTriggeredAt) {
          log("debug", "cron", `Post-management screening skipped — already triggered by concurrent call`);
        } else if (runScreeningCycle) {
          log("info", "cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
          const p = runScreeningCycle();
          if (p && typeof p.catch === "function") {
            p.catch((e) => { log("error", "cron", `Triggered screening failed: ${e?.message ?? e}`); });
          }
        } else {
          log("error", "cron", "Screening cycle module missing runScreeningCycle export");
        }
      }).catch(e => {
        _busyState._screeningBusy = false;
        log("error", "cron", `Failed to import screening cycle: ${e?.message ?? String(e)}`);
      });
    }

  } catch (error) {
    log("error", "cron", `Management cycle failed: ${error?.message ?? String(error)}`);
    mgmtReport = `Management cycle failed: ${error?.message ?? String(error)}`;
  } finally {
    const finallyStart = Date.now();
    log("info", "cron", `Management cycle finally block entered after ${finallyStart - cycleStart}ms`);
    _busyState._managementBusy = false;
    log("info", "cron", `Management cycle complete: ${finallyStart - cycleStart}ms total`);
    // Drain queued Telegram commands after releasing the busy flag (fire-and-forget)
    drainTelegramQueue();
    if (!silent && telegramIsEnabled()) {
      // Batch OOR positions
      const oorPositions = positions.filter(
        (p) => p && !p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes
      );
      for (const p of oorPositions) {
        if (!p) continue;
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
        oorPositions.filter(Boolean).length === 0 &&
        !hasPendingNotifications();

      if (!isAllHealthy || mgmtReport) {
        buildAndSendConsolidatedReport({ mgmtReport, oorPositions, positions });
      }
      log("info", "cron", `Management cycle finally complete: ${Date.now() - finallyStart}ms (report sent)`);
    } else {
      log("info", "cron", `Management cycle finally complete: ${Date.now() - finallyStart}ms (silent or telegram disabled)`);
    }
  }
  return mgmtReport;
}
