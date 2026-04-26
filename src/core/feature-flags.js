/**
 * Feature Flag Infrastructure
 *
 * Provides a key-value store for enabling/disabling features at runtime.
 * All flags are stored in the kv_store table with a "flag_" prefix.
 * PLANNED_FLAGS are initialized to "false" on first migrate() call.
 */

import { getDB } from "./db.js";

const FLAG_PREFIX = "flag_";

export const PLANNED_FLAGS = [
  "gmgn_holders_enabled",
  "gmgn_price_enabled",
  "bb_strategy_enabled",
  "dynamic_sizing_enabled",
  "auto_shift_bins_enabled",
  "auto_claim_sol_enabled",
  "dynamic_oor_wait_enabled",
  "token_security_enabled",
];

/**
 * Check if a feature flag is enabled.
 * @param {string} flagName - Flag name without the "flag_" prefix
 * @returns {boolean}
 */
export function isFlagEnabled(flagName) {
  const db = getDB();
  const row = db.prepare(`SELECT value FROM kv_store WHERE key = ?`).get(FLAG_PREFIX + flagName);
  return row?.value === "true";
}

/**
 * Enable or disable a feature flag.
 * @param {string} flagName - Flag name without the "flag_" prefix
 * @param {boolean} enabled
 */
export function setFlag(flagName, enabled) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`).run(
    FLAG_PREFIX + flagName, enabled ? "true" : "false"
  );
}

/**
 * Get all feature flags and their values.
 * @returns {Object} flagName -> "true"|"false"
 */
export function getAllFlags() {
  const db = getDB();
  const rows = db.prepare(`SELECT key, value FROM kv_store WHERE key LIKE ?`).all(FLAG_PREFIX + "%");
  return Object.fromEntries(rows.map(r => [r.key.replace(FLAG_PREFIX, ""), r.value]));
}
