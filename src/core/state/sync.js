/**
 * Sync open positions — reconciles local SQLite state with on-chain positions.
 * All functions share the same getDB() from ../db.js.
 */

import { getDB, runTransaction } from "../db.js";
import { log } from "../logger.js";
import { updatePosition, appendNote } from "./registry.js";

// ─── Sync ───────────────────────────────────────────────────────────────────

const SYNC_GRACE_MS = 5 * 60_000;

/**
 * Track consecutive sync misses per position.
 * A position must be missing for REQUIRED_MISSES consecutive syncs
 * before being auto-closed. This prevents premature closure when the
 * Meteora API returns empty or incomplete data temporarily.
 */
const _syncMissCount = new Map();
const REQUIRED_MISSES = 2;

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are absent from the on-chain list
 * for REQUIRED_MISSES consecutive sync calls.
 * Positions deployed within the last 5 minutes are excluded (grace period).
 *
 * NOTE: active_addresses is snapshotted at call time. A position deployed
 * on-chain while this function runs may be incorrectly auto-closed if it hasn't
 * propagated into active_addresses yet. This is a known design limitation.
 *
 * @param {string[]} active_addresses - List of currently active on-chain position addresses
 * @returns {void}
 */
export async function syncOpenPositions(active_addresses) {
  const db = await getDB();
  const activeSet = new Set(active_addresses);
  const openPos = db.prepare("SELECT position, deployed_at FROM positions WHERE closed = 0").all();

  // Clear miss count for any position that IS in the active set
  for (const addr of activeSet) {
    if (_syncMissCount.has(addr)) {
      _syncMissCount.delete(addr);
    }
  }

  runTransaction(() => {
    for (const pos of openPos) {
      if (activeSet.has(pos.position)) continue;

      const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
      if (Date.now() - deployedAt < SYNC_GRACE_MS) {
        log("info", "state", `Position ${pos.position} not on-chain yet — within grace period, skipping auto-close`);
        continue;
      }

      // Increment miss count — only auto-close after REQUIRED_MISSES consecutive misses
      const misses = (_syncMissCount.get(pos.position) || 0) + 1;
      _syncMissCount.set(pos.position, misses);

      if (misses < REQUIRED_MISSES) {
        log("info", "state", `Position ${pos.position} missing from on-chain data (miss ${misses}/${REQUIRED_MISSES}) — waiting for confirmation`);
        continue;
      }

      const closed_at = new Date().toISOString();
      updatePosition(pos.position, { closed: 1, closed_at }, db);
      appendNote(pos.position, `Auto-closed during state sync (missing from on-chain data for ${misses} consecutive syncs)`, db);
      log("info", "state", `Position ${pos.position} auto-closed (missing from on-chain data for ${misses} consecutive syncs)`);
      _syncMissCount.delete(pos.position);
    }
  });
}

