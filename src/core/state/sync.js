/**
 * Sync open positions — reconciles local SQLite state with on-chain positions.
 * All functions share the same getDB() from ../db.js.
 */

import { getDB } from "../db.js";
import { log } from "../logger.js";

// ─── Sync ───────────────────────────────────────────────────────────────────

const SYNC_GRACE_MS = 5 * 60_000;

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 * Positions deployed within the last 5 minutes are excluded (grace period).
 * @param {string[]} active_addresses - List of currently active on-chain position addresses
 * @returns {void}
 */
export function syncOpenPositions(active_addresses) {
  const db = getDB();
  const activeSet = new Set(active_addresses);
  const openPos = db.prepare("SELECT position, deployed_at FROM positions WHERE closed = 0").all();

  db.transaction(() => {
    for (const pos of openPos) {
      if (activeSet.has(pos.position)) continue;

      const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
      if (Date.now() - deployedAt < SYNC_GRACE_MS) {
        log("info", "state", `Position ${pos.position} not on-chain yet — within grace period, skipping auto-close`);
        continue;
      }

      const closed_at = new Date().toISOString();
      updatePosition(pos.position, { closed: 1, closed_at });
      appendNote(pos.position, `Auto-closed during state sync (not found on-chain)`);
      log("info", "state", `Position ${pos.position} auto-closed (missing from on-chain data)`);
    }
  })();
}

// ─── Internal helpers (duplicated from registry to avoid circular deps) ───────

function updatePosition(position_address, updates) {
  const db = getDB();
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setCols = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => updates[k]);
  values.push(position_address);
  db.prepare(`UPDATE positions SET ${setCols} WHERE position = ?`).run(...values);
}

function appendNote(position_address, note) {
  const db = getDB();
  const pos = db.prepare("SELECT notes FROM positions WHERE position = ?").get(position_address);
  if (!pos) return;
  let notes = [];
  try { notes = JSON.parse(pos.notes || "[]"); } catch (e) {
    log("warn", "state", `Failed to parse position notes: ${e?.message}`);
    notes = [];
  }
  notes.push(note);
  updatePosition(position_address, { notes: JSON.stringify(notes) });
}
