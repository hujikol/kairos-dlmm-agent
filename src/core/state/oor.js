/**
 * OOR (Out-Of-Range) state — single source of truth for out_of_range_since.
 * All OOR writes go through markOutOfRange / markInRange.
 * updatePnlAndCheckExits calls these instead of writing OOR directly.
 */

import { getDB } from "../db.js";
import { log } from "../logger.js";

// ─── OOR State — Single Source of Truth ─────────────────────────────────────

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const db = getDB();
  const pos = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get(position_address);
  if (pos && !pos.out_of_range_since) {
    updateOORPosition(position_address, { out_of_range_since: new Date().toISOString() });
    log("info", "state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const db = getDB();
  const pos = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get(position_address);
  if (pos && pos.out_of_range_since) {
    updateOORPosition(position_address, { out_of_range_since: null });
    log("info", "state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const db = getDB();
  const pos = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get(position_address);
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function updateOORPosition(position_address, updates) {
  const db = getDB();
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setCols = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => updates[k]);
  values.push(position_address);
  db.prepare(`UPDATE positions SET ${setCols} WHERE position = ?`).run(...values);
}
