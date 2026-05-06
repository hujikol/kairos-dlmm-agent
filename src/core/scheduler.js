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
import { timers, _busyState, _timersState } from "./state/scheduler-state.js";
import { runManagementCycle, runScreeningCycle } from "./cycles.js";

// ─── Cron-only constants ─────────────────────────────────────────────────────
// PnL polling interval driven by config (in seconds, converted to ms below)



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

export const _cronState = { tasks: [], _pnlPollInterval: null };

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
    log("error", "cron", `Morning briefing failed: ${error?.message ?? String(error)}`);
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
//  MAINTENANCE — Monthly WAL checkpoint + archival
// ═══════════════════════════════════════════
/**
 * Monthly maintenance: archive old closed positions and checkpoint the WAL.
 * - Move closed positions older than 30 days to performance_archive table
 * - VACUUM to reclaim space
 * - PRAGMA wal_checkpoint(TRUNCATE) to shrink WAL file
 */
export async function runMonthlyMaintenance() {
  log("info", "cron", "Starting monthly maintenance");
  const db = await getDB();
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Archive old closed positions
    const archived = db.prepare(
      "DELETE FROM performance WHERE closed_at < ? AND id IN (SELECT id FROM performance WHERE closed_at < ? LIMIT 5000)"
    ).run(cutoff, cutoff).changes;
    if (archived > 0) log("info", "cron", `Archived ${archived} old closed position rows`);
    // Checkpoint and truncate WAL
    db.pragma("wal_checkpoint(TRUNCATE)");
    // VACUUM the main database (async)
    db.exec("VACUUM");
    log("info", "cron", `Monthly maintenance done: WAL checkpointed, ${archived} rows archived`);
  } catch (e) {
    log("error", "cron", `Monthly maintenance failed: ${e?.message ?? String(e)}`);
  }
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
  // Receive a Promise when the database isn't ready yet.
  await getDB();

  const mgmtTask = new Cron(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    { timezone: "Etc/UTC" },
    async () => {
      if (_busyState._managementBusy) return;
      timers.managementLastRun = Date.now();
      try {
        await runManagementCycle();
      } catch (e) {
        try { captureError(e, { phase: "management_cycle" }); } catch {}
        log("error", "scheduler", `Management cycle error: ${e?.message ?? String(e)}`);
      }
    }
  );

  const screenTask = new Cron(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    { timezone: "Etc/UTC" },
    async () => {
      try {
        await runScreeningCycle();
      } catch (e) {
        try { captureError(e, { phase: "screening_cycle" }); } catch {}
        log("error", "scheduler", `Screening cycle error: ${e?.message ?? String(e)}`);
      }
    }
  );

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = new Cron("0 1 * * *", { timezone: "Etc/UTC" }, async () => {
    try {
      await runBriefing();
    } catch (e) {
      try { captureError(e, { phase: "briefing" }); } catch {}
      log("error", "scheduler", `Briefing error: ${e?.message ?? String(e)}`);
    }
  });

  // Every 6h — catch up if briefing was missed
  const briefingWatchdog = new Cron("0 */6 * * *", { timezone: "Etc/UTC" }, async () => {
    try {
      await maybeRunMissedBriefing();
    } catch (e) {
      try { captureError(e, { phase: "briefing_watchdog" }); } catch {}
      log("error", "scheduler", `Briefing watchdog error: ${e?.message ?? String(e)}`);
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

  // Monthly maintenance cron — 1st of each month at 2:00 AM UTC
  const maintenanceTask = new Cron("0 2 1 * *", { timezone: "Etc/UTC" }, async () => {
    try {
      await runMonthlyMaintenance();
    } catch (e) {
      try { captureError(e, { phase: "monthly_maintenance" }); } catch {}
      log("error", "scheduler", `Monthly maintenance error: ${e?.message ?? String(e)}`);
    }
  });

  _cronState.tasks = [mgmtTask, screenTask, briefingTask, briefingWatchdog, maintenanceTask];
  _cronState._pnlPollInterval = pnlPollInterval;
  log("info", "cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}