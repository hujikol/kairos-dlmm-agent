/**
 * Watchdog — polls open positions every 60s for emergency conditions.
 * Does NOT call LLM unless explicitly triggered.
 */

import { getDB } from './core/db.js';
import { getPositionPnl as _defaultGetPositionPnl, closePosition, getMyPositions } from './integrations/meteora.js';
import { pushNotification } from './notifications/queue.js';
import { markOutOfRange } from "./core/state/oor.js";
import { syncOpenPositions } from "./core/state/sync.js";
import { log } from './core/logger.js';
import { captureAlert } from './instrument.js';
import { runManagementCycle } from './core/cycles.js';
import { WATCHDOG_POLL_INTERVAL_MS } from './core/constants.js';

// Mutable dependency refs — allow tests to inject mocks
let _getPositionPnl = _defaultGetPositionPnl;
export function _setGetPositionPnl(fn) { _getPositionPnl = fn; }

let _getMyPositions = getMyPositions;
export function _setGetMyPositions(fn) { _getMyPositions = fn; }

let _pushNotification = pushNotification;
export function _setPushNotification(fn) { _pushNotification = fn; }

let _captureAlert = captureAlert;
export function _setCaptureAlert(fn) { _captureAlert = fn; }

let _runManagementCycle = runManagementCycle;
export function _setRunManagementCycle(fn) { _runManagementCycle = fn; }

let _syncOpenPositions = syncOpenPositions;
export function _setSyncOpenPositions(fn) { _syncOpenPositions = fn; }

let _markOutOfRange = markOutOfRange;
export function _setMarkOutOfRange(fn) { _markOutOfRange = fn; }

let _closePosition = closePosition;
export function _setClosePosition(fn) { _closePosition = fn; }

// Mutable poll interval - allow tests to use short interval
let _pollInterval = WATCHDOG_POLL_INTERVAL_MS;
export function _setPollInterval(ms) { _pollInterval = ms; }

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
  _pushNotification({
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
      const result = _getMyPositions();
      const resolved = result && typeof result.then === "function" ? await result : result;
      const livePositions = resolved || { positions: [] };
      await _syncOpenPositions(livePositions.positions.map(p => p.position));
    } catch (e) {
      log("warn", "watchdog", `Sync step failed: ${e.message}`);
    }

    const db = getDB();
    const positions = db.prepare('SELECT * FROM positions WHERE closed = 0 AND status = ?').all('active');

    for (const pos of positions) {
      try {
        const live = await _getPositionPnl({ pool_address: pos.pool, position_address: pos.position });

        if (live.error) {
          log("error", "watchdog", `Failed to get PnL for ${pos.position}: ${live.error}`);
          const fails = recordFailure(pos.position);
          if (fails === 3) {
            _captureAlert(`Watchdog: 3 consecutive failures for ${pos.pool_name || pos.position}`);
          }
          if (fails >= 5) {
            markStaleAndRemove(pos.position, pos);
          }
          continue;
        }

        // PnL API had a gap but position confirmed on-chain — skip failure counting
        // but do not update PnL state (leave previous reading intact)
        if (live._apiGap) {
          log("warn", "watchdog", `PnL API gap for ${pos.position} — position verified on-chain, skipping PnL update`);
          clearFailure(pos.position);
          continue;
        }

        // Successful poll — clear any accumulated failure count
        clearFailure(pos.position);

        // Emergency close — no LLM, close immediately
        if (live.pnl_pct != null && live.pnl_pct <= config.management.stopLossPct) {
          log("warn", "watchdog", `EMERGENCY CLOSE: ${pos.pool_name} PnL=${live.pnl_pct}%`);
          _captureAlert(`EMERGENCY CLOSE triggered: ${pos.pool_name} at PnL=${live.pnl_pct}%`);
          const result = await _closePosition({ position_address: pos.position, reason: 'emergency_loss' });
          _pushNotification({
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
            _runManagementCycle({ silent: true })
              .catch((e) => log("error", "watchdog", `Unscheduled management cycle failed: ${e?.message ?? String(e)}`))
              .finally(() => { _healerRunning = false; });
          }
        }

        // Out-of-range tracking — update oor timestamp if needed
        if (!live.in_range) {
          _markOutOfRange(pos.position);
        }

      } catch (e) {
        log("error", "watchdog", `Watchdog error on ${pos.position}: ${e.message}`);
        const fails = recordFailure(pos.position);
        if (fails === 3) {
          _captureAlert(`Watchdog: 3 consecutive failures for ${pos.pool_name || pos.position}`);
        }
        if (fails >= 5) {
          markStaleAndRemove(pos.position, pos);
          continue;
        }
      }
    }
    // Cleanup consecutive failures for closed positions
    const activePositions = new Set(positions.map(p => p.position));
    for (const addr of _consecutiveFailures.keys()) {
      if (!activePositions.has(addr)) _consecutiveFailures.delete(addr);
    }
  }, _pollInterval);
}
