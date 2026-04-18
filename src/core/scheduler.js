import { Cron } from "croner";
import { config } from "../config.js";
import { log } from "./logger.js";
import { getDB } from "./db.js";
import { getMyPositions } from "../integrations/meteora.js";
import { setLastBriefingDate, getLastBriefingDate } from "./state/registry.js";
import { updatePnlAndCheckExits } from "./state/pnl.js";
import { sendHTML, isEnabled as telegramEnabled } from "../notifications/telegram.js";
import { generateBriefing } from "../notifications/briefing.js";
import { captureError } from "../instrument.js";

// ─── Cron-only constants ─────────────────────────────────────────────────────
// PnL polling interval driven by config (in seconds, converted to ms below)

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
export const _cronState = { tasks: [], _pnlPollInterval: null };
// NOTE: Node.js v24 regressed — exported `let` bindings are read-only when imported.
// Use object wrapper so imported modules can modify properties (not bindings).
export const _busyState = {
  _managementBusy: false,
  _screeningBusy: false,
  _pnlPollBusy: false,
};
// Also use object wrapper for timestamps to avoid ESM live-binding reassignment issues
export const _timersState = {
  screeningLastTriggered: 0,
  pollTriggeredAt: 0,
};

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
  for (const task of _cronState.tasks) task.stop();
  if (_cronState._pnlPollInterval) clearInterval(_cronState._pnlPollInterval);
  _cronState.tasks = [];
}

// ─── Cycle functions (imported from cycles.js to break circular dep) ───────────
// cycles.js imports state (timers, _managementBusy, etc.) from this file,
// but these are initialized before cycles.js loads, so the live bindings are
// available when cycles.js needs them.

export async function startCronJobs() {
  stopCronJobs();

  // Ensure DB is initialized before any cron callback runs.
  // This prevents sync getDB() callers in cycle functions from
  // receiving a Promise when the database isn't ready yet.
  await getDB();

  const { runManagementCycle, runScreeningCycle } = await import("./cycles.js");

  const mgmtTask = new Cron(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    { timezone: "Etc/UTC" },
    async () => {
      if (_busyState._managementBusy) return;
      timers.managementLastRun = Date.now();
      Promise.resolve().then(() => runManagementCycle()).catch((e) => {
        captureError(e, { phase: "management_cycle" });
        log("error", "scheduler", `Management cycle error: ${e.message}`);
      });
    }
  );

  const screenTask = new Cron(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    { timezone: "Etc/UTC" },
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
  const briefingTask = new Cron("0 1 * * *", { timezone: "Etc/UTC" }, async () => {
    try {
      await runBriefing();
    } catch (e) {
      captureError(e, { phase: "briefing" });
      log("error", "scheduler", `Briefing error: ${e.message}`);
    }
  });

  // Every 6h — catch up if briefing was missed
  const briefingWatchdog = new Cron("0 */6 * * *", { timezone: "Etc/UTC" }, async () => {
    try {
      await maybeRunMissedBriefing();
    } catch (e) {
      captureError(e, { phase: "briefing_watchdog" });
      log("error", "scheduler", `Briefing watchdog error: ${e.message}`);
    }
  });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles
  const pnlPollInterval = setInterval(async () => {
    if (_busyState._managementBusy || _busyState._screeningBusy || _busyState._pnlPollBusy) return;
    _busyState._pnlPollBusy = true;
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
          const sinceLastTrigger = Date.now() - _timersState.pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _timersState.pollTriggeredAt = Date.now();
            log("info", "state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            Promise.resolve(runManagementCycle({ silent: true })).catch((e) => { log("error", "cron", `Poll-triggered management failed: ${e?.message ?? e}`); });
          } else {
            log("info", "state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _busyState._pnlPollBusy = false;
    }
  }, config.schedule.pnlPollIntervalSec * 1000);

  _cronState.tasks = [mgmtTask, screenTask, briefingTask, briefingWatchdog];
  _cronState._pnlPollInterval = pnlPollInterval;
  log("info", "cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}