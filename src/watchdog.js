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
import { runManagementCycle } from './index.js';
import { WATCHDOG_POLL_INTERVAL_MS } from './core/constants.js';

// Track healer cycle state to prevent overlapping unscheduled runs
let _healerRunning = false;

export function setHealerRunning(v) { _healerRunning = v; }

/**
 * Start the watchdog polling loop.
 * @param {Object} config - runtime config (from config.js)
 */
export async function startWatchdog(config) {
  log("info", "watchdog", "Watchdog started — polling every 60s");

  setInterval(async () => {
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
          continue;
        }

        // Emergency close — no LLM, close immediately
        if (live.pnl_pct != null && live.pnl_pct <= config.management.stopLossPct) {
          log("warn", "watchdog", `EMERGENCY CLOSE: ${pos.pool_name} PnL=${live.pnl_pct}%`);
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
        if (live.pnl_pct != null && live.pnl_pct <= -4 && !_healerRunning) {
          log("info", "watchdog", `Soft loss detected (${live.pnl_pct}%) for ${pos.pool_name} — triggering unscheduled management cycle`);
          _healerRunning = true;
          runManagementCycle({ silent: true })
            .catch((e) => log("error", "watchdog", `Unscheduled management cycle failed: ${e.message}`))
            .finally(() => { _healerRunning = false; });
        }

        // Out-of-range tracking — update oor timestamp if needed
        if (!live.in_range) {
          markOutOfRange(pos.position);
        }

      } catch (e) {
        log("error", "watchdog", `Watchdog error on ${pos.position}: ${e.message}`);
      }
    }
  }, WATCHDOG_POLL_INTERVAL_MS);
}
