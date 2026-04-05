/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import { getDB } from "../core/db.js";
import { log } from "../core/logger.js";

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = getDB();
  const row = db.prepare('SELECT 1 FROM token_blacklist WHERE mint = ?').get(mint);
  return !!row;
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };

  const db = getDB();
  const existing = db.prepare('SELECT * FROM token_blacklist WHERE mint = ?').get(mint);

  if (existing) {
    return {
      already_blacklisted: true,
      mint,
      symbol: existing.symbol,
      reason: existing.reason,
    };
  }

  db.prepare(`
    INSERT INTO token_blacklist (mint, symbol, reason, added_at, added_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(mint, symbol || "UNKNOWN", reason || "no reason provided", new Date().toISOString(), "agent");

  log("info", "blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const db = getDB();
  const entry = db.prepare('SELECT * FROM token_blacklist WHERE mint = ?').get(mint);

  if (!entry) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  db.prepare('DELETE FROM token_blacklist WHERE mint = ?').run(mint);
  log("info", "blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist() {
  const db = getDB();
  const entries = db.prepare('SELECT * FROM token_blacklist').all();

  return {
    count: entries.length,
    blacklist: entries,
  };
}
