/**
 * Watchdog — polls open positions every 60s for emergency conditions.
 * Does NOT call LLM unless explicitly triggered.
 */

import { getDB } from './core/db.js';
import { getPositionPnl, closePosition, getMyPositions } from './integrations/meteora.js';
import { pushNotification } from './notifications/queue.js';
import { markOutOfRange } from "./core/state/oor.js";
import { syncOpenPositions } from "./core/state/sync.js";
import { log } from './core/logger.js';
import { captureAlert } from './instrument.js';
import { runManagementCycle } from './core/cycles.js';
import { WATCHDOG_POLL_INTERVAL_MS } from './core/constants.js';

// Track healer cycle state to prevent overlapping unscheduled runs
let _healerRunning = false;
let _watchdogInterval = null;

// Track consecutive failures per position address
const _consecutiveFailures = new Map();

export function setHealerRunning(v) { _healerRunning = v; }

/**
 * Stop the watchdog polling loop.
 */
export function stopWatchdog() {
  if (_watchdogInterval) {
    clearInterval(_watchdogInterval);
    _watchdogInterval = null;
    log("info", "watchdog", "Watchdog stopped");
  }
}

/**
 * Record a consecutive failure for a position. Returns the new count.
 */
function recordFailure(posAddress) {
  const count = (_consecutiveFailures.get(posAddress) || 0) + 1;
  _consecutiveFailures.set(posAddress, count);
  return count;
}

/**
 * Clear failure count on successful poll for a position.
 */
function clearFailure(posAddress) {
  _consecutiveFailures.delete(posAddress);
}

/**
 * Remove a position from the watch list due to staleness.
 */
function markStaleAndRemove(posAddress, pos) {
  const db = getDB();
  db.prepare("UPDATE positions SET status = ? WHERE position = ?").run("stale", posAddress);
  _consecutiveFailures.delete(posAddress);
  log("warn", "watchdog", `Position ${pos.pool_name} marked stale after 5 consecutive failures`);
  pushNotification({
    type: "stale",
    pair: pos.pool_name || pos.pool,
    reason: "consecutive_failures",
  });
}

/**
 * Start the watchdog polling loop.
 * @param {Object} config - runtime config (from config.js)
 */
export async function startWatchdog(config) {
  log("info", "watchdog", "Watchdog started — polling every 60s");

  _watchdogInterval = setInterval(async () => {
    // Sync local DB with on-chain reality — marks stale positions as closed
    try {
      const { positions: livePositions } = await getMyPositions().catch(() => ({ positions: [] }));
      syncOpenPositions(livePositions.map(p => p.position));
    } catch (e) {
      log("warn", "watchdog", `Sync step failed: ${e.message}`);
    }

    const db = getDB();
    const positions = db.prepare('SELECT * FROM positions WHERE closed = 0 AND status = ?').all('active');

    for (const pos of positions) {
      try {
        const live = await getPositionPnl({ pool_address: pos.pool, position_address: pos.position });

        if (live.error) {
          log("error", "watchdog", `Failed to get PnL for ${pos.position}: ${live.error}`);
          const fails = recordFailure(pos.position);
          if (fails === 3) {
            captureAlert(`Watchdog: 3 consecutive failures for ${pos.pool_name || pos.position}`);
          }
          if (fails >= 5) {
            markStaleAndRemove(pos.position, pos);
          }
          continue;
        }

        // Successful poll — clear any accumulated failure count
        clearFailure(pos.position);

        // Emergency close — no LLM, close immediately
        if (live.pnl_pct != null && live.pnl_pct <= config.management.stopLossPct) {
          log("warn", "watchdog", `EMERGENCY CLOSE: ${pos.pool_name} PnL=${live.pnl_pct}%`);
          captureAlert(`EMERGENCY CLOSE triggered: ${pos.pool_name} at PnL=${live.pnl_pct}%`);
          const result = await closePosition({ position_address: pos.position, reason: 'emergency_loss' });
          pushNotification({
            type: 'close',
            pair: pos.pool_name || pos.pool,
            pnlUsd: live.pnl_usd ?? 0,
            pnlPct: live.pnl_pct ?? 0,
            reason: 'emergency_loss',
          });
          if (result?.success !== false) {
            log("info", "watchdog", `Emergency close succeeded for ${pos.position}`);
          }
          continue;
        }

        // Soft warning — trigger unscheduled healer/management cycle
        // Atomic check-and-set to avoid TOCTOU race between concurrent iterations
        if (live.pnl_pct != null && live.pnl_pct <= -4) {
          if (_healerRunning) {
            log("debug", "watchdog", `Soft loss detected but healer already running — skipping for ${pos.pool_name}`);
          } else {
            _healerRunning = true;
            log("info", "watchdog", `Soft loss detected (${live.pnl_pct}%) for ${pos.pool_name} — triggering unscheduled management cycle`);
            runManagementCycle({ silent: true })
              .catch((e) => log("error", "watchdog", `Unscheduled management cycle failed: ${e.message}`))
              .finally(() => { _healerRunning = false; });
          }
        }

        // Out-of-range tracking — update oor timestamp if needed
        if (!live.in_range) {
          markOutOfRange(pos.position);
        }

      } catch (e) {
        log("error", "watchdog", `Watchdog error on ${pos.position}: ${e.message}`);
        const fails = recordFailure(pos.position);
        if (fails === 3) {
          captureAlert(`Watchdog: 3 consecutive failures for ${pos.pool_name || pos.position}`);
        }
        if (fails >= 5) {
          markStaleAndRemove(pos.position, pos);
          continue;
        }
      }
    }
  }, WATCHDOG_POLL_INTERVAL_MS);
}
