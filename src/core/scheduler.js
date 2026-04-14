import cron from "node-cron";
import { config } from "../config.js";
import { log } from "./logger.js";
import { getMyPositions } from "../integrations/meteora.js";
import { setLastBriefingDate, getLastBriefingDate } from "./state/registry.js";
import { updatePnlAndCheckExits } from "./state/pnl.js";
import { sendHTML, isEnabled as telegramEnabled } from "../notifications/telegram.js";
import { generateBriefing } from "../notifications/briefing.js";
import { captureError } from "../instrument.js";

// ─── Cron-only constants ─────────────────────────────────────────────────────
const PNL_POLL_INTERVAL_MS = 30_000; // 30s PnL polling interval

// ═══════════════════════════════════════════
//  CYCLE TIMERS (shared with index.js for buildPrompt)
// ═══════════════════════════════════════════
export const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

export function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

export function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ═══════════════════════════════════════════
//  CRON STATE (re-exported so index.js can use guards)
// ═══════════════════════════════════════════
export let _cronTasks = [];
export let _managementBusy = false;
export let _screeningBusy = false;
export let _screeningLastTriggered = 0;
export let _pollTriggeredAt = 0;

// ═══════════════════════════════════════════
//  BRIEFING CRON FUNCTIONS
// ═══════════════════════════════════════════
export async function runBriefing() {
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
export async function maybeRunMissedBriefing() {
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

// ═══════════════════════════════════════════
//  START / STOP
// ═══════════════════════════════════════════
export function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

// Imported lazily to avoid circular dependency
let _cyclesPromise = null;

async function getCycles() {
  if (!_cyclesPromise) {
    _cyclesPromise = import("../index.js");
  }
  const mod = await _cyclesPromise;
  return { runManagementCycle: mod.runManagementCycle, runScreeningCycle: mod.runScreeningCycle };
}

export async function startCronJobs() {
  stopCronJobs();

  const { runManagementCycle, runScreeningCycle } = await getCycles();

  const mgmtTask = cron.schedule(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    async () => {
      if (_managementBusy) return;
      timers.managementLastRun = Date.now();
      try {
        await runManagementCycle();
      } catch (e) {
        captureError(e, { phase: "management_cycle" });
        log("error", "scheduler", `Management cycle error: ${e.message}`);
      }
    }
  );

  const screenTask = cron.schedule(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    async () => {
      try {
        await runScreeningCycle();
      } catch (e) {
        captureError(e, { phase: "screening_cycle" });
        log("error", "scheduler", `Screening cycle error: ${e.message}`);
      }
    }
  );

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule("0 1 * * *", async () => {
    try {
      await runBriefing();
    } catch (e) {
      captureError(e, { phase: "briefing" });
      log("error", "scheduler", `Briefing error: ${e.message}`);
    }
  }, { timezone: "UTC" });

  // Every 6h — catch up if briefing was missed
  const briefingWatchdog = cron.schedule("0 */6 * * *", async () => {
    try {
      await maybeRunMissedBriefing();
    } catch (e) {
      captureError(e, { phase: "briefing_watchdog" });
      log("error", "scheduler", `Briefing watchdog error: ${e.message}`);
    }
  }, { timezone: "UTC" });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(e => {
        log("warn", "pnl", `getMyPositions failed: ${e?.message ?? e}`);
        return null;
      });
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("info", "state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            _runManagementCycle({ silent: true }).catch((e) => log("error", "cron", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("info", "state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, PNL_POLL_INTERVAL_MS);

  _cronTasks = [mgmtTask, screenTask, briefingTask, briefingWatchdog];
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("info", "cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}