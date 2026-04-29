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
 * @param {string} position_address - The position address to mark as out of range
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
 * @param {string} position_address - The position address to mark as back in range
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
 * @param {string} position_address - The position address to check
 * @returns {number} - Minutes out of range, or 0 if currently in range
 */
export function minutesOutOfRange(position_address) {
  const db = getDB();
  const pos = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get(position_address);
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * How many minutes until a position goes out of range, given current volatility.
 * Uses dynamic OOR wait config: max at vol=0, min at vol=4.
 * @param {string} _position_address - Position address (unused, for signature compatibility)
 * @param {number} poolVolatility - Pool volatility score 0-4
 * @param {number|null} waitMinutes - Override wait time directly
 * @returns {number} Minutes until OOR
 */
export function minutesUntilOor(_position_address, poolVolatility, waitMinutes = null) {
  if (waitMinutes !== null) return waitMinutes;
  const min = 3;
  const max = 20;
  const clampedVol = Math.min(Math.max(poolVolatility, 0), 4);
  const wait = max - (clampedVol / 4) * (max - min);
  return Math.round(wait);
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
