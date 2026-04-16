/**
 * Management cycle — monitors open positions, applies deterministic rules,
 * calls LLM (via agentGateway) when action is needed.
 */

import { log } from "./logger.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { config, computeDeployAmount } from "../config.js";
import {
  timers,
  _busyState,
  _screeningLastTriggered,
} from "./scheduler.js";
import { checkDailyCircuitBreaker, getDailyPnL } from "./daily-tracker.js";
import { captureAlert } from "../instrument.js";
import { getTrackedPosition } from "./state/registry.js";
import { updatePnlAndCheckExits } from "./state/pnl.js";
import { recordPositionSnapshot, recallForPool } from "../features/pool-memory.js";
import { pushNotification, hasPendingNotifications } from "../notifications/queue.js";
import { isEnabled as telegramIsEnabled } from "../notifications/telegram.js";
import {
  computeManagementActions,
  buildManagementReport,
  autoSwapAndNotify,
  buildAndSendConsolidatedReport,
} from "./management-helpers.js";
import { SCREENING_COOLDOWN_MS } from "./constants.js";
import { defaultGateway as agentGateway } from "./agent-gateway.js";

const IS_DRY_RUN = process.env.DRY_RUN === "true";

export async function runManagementCycle({ silent = false, gateway = agentGateway } = {}) {
  if (_busyState._managementBusy) return null;
  _busyState._managementBusy = true;
  timers.managementLastRun = Date.now();
  log("info", "cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];

  try {
    // Daily PnL circuit breaker
    const pnl = getDailyPnL();
    const circuit = checkDailyCircuitBreaker();
    log("info", "daily-pnl", `Circuit breaker: ${circuit.action} (realized: ${pnl.realized?.toFixed(2) ?? "N/A"} USD, reason: ${circuit.reason || "normal"})`);
    if (circuit.action === "halt") {
      log("warn", "daily-pnl", `CIRCUIT BREAKER: daily loss limit hit — skipping new deployments this cycle`);
      captureAlert(`CIRCUIT BREAKER HALT: daily loss limit hit (realized PnL: ${pnl.realized?.toFixed(2) ?? "N/A"} USD)`);
      // Still manage existing positions (close/claim) in halt mode
    }

    const [livePositions, currentBalance] = await Promise.all([
      getMyPositions({ force: true }).catch(e => { log("warn", "cron", `getMyPositions failed: ${e?.message ?? e}`); return null; }),
      getWalletBalances(),
    ]);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("info", "cron", "No open positions — triggering screening cycle");
      // Dynamic import to avoid circular dep with scheduler.js
      const { runScreeningCycle } = await import("./screening-cycle.js");
      runScreeningCycle().catch((e) => { try { log("error", "cron", `Triggered screening failed: ${e.message}`); } catch {} });
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

      const { content } = await gateway.runManagementCycle({
        actionBlocks,
        actionPositions,
        currentBalance,
        livePositions,
      });

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
    const lastTriggeredAt = _screeningLastTriggered;

    // Dynamic import to avoid circular dep with scheduler.js
    const { runScreeningCycle } = await import("./screening-cycle.js");

    if (afterCount < config.risk.maxPositions && Date.now() - lastTriggeredAt > SCREENING_COOLDOWN_MS && circuit.action !== "halt") {
      if (_busyState._screeningBusy) return;
      _busyState._screeningBusy = true;
      try {
        // Re-check to avoid race: if another call set _screeningLastTriggered while we were waiting for the lock
        if (_screeningLastTriggered !== lastTriggeredAt) {
          log("info", "cron", `Post-management screening skipped — already triggered by concurrent call`);
        } else {
          log("info", "cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
          runScreeningCycle().catch((e) => { try { log("error", "cron", `Triggered screening failed: ${e.message}`); } catch {} });
        }
      } finally {
        _busyState._screeningBusy = false;
      }
    }
  } catch (error) {
    log("error", "cron", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _busyState._managementBusy = false;
    if (!silent && telegramIsEnabled()) {
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
