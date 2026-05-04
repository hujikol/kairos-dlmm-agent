/**
 * Post-mortem DB persistence and rule storage.
 *
 * Handles:
 *   - SQLite table creation (ensureTable)
 *   - Loading rules from DB (with legacy JSON fallback migration)
 *   - Saving/updating rules to DB (saveRules)
 *   - Query API (loadRules, clearRules)
 */

import fs from "fs";
import { getDB, runTransaction } from "../db.js";
import { log } from "../logger.js";

const POSTMORTEM_FILE = "./postmortem-rules.json";
const MAX_RULES = 50;

export function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS postmortem_rules (
      key TEXT PRIMARY KEY,
      type TEXT,
      strategy TEXT,
      bin_step_range TEXT,
      volatility_range TEXT,
      reason TEXT,
      frequency INTEGER,
      count INTEGER,
      hours_utc TEXT,
      win_rate INTEGER,
      sample_size INTEGER,
      evidence TEXT,
      severity TEXT,
      description TEXT,
      suggestion TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

/**
 * Load all postmortem rules from DB, migrating legacy JSON on first run.
 * @returns {Array}
 */
export function loadRules() {
  const db = getDB();
  ensureTable(db);

  // Try DB first
  try {
    const rows = db.prepare("SELECT * FROM postmortem_rules ORDER BY created_at ASC").all();
    if (rows.length > 0) {
      return rows.map(row => ({
        ...row,
        bin_step_range: row.bin_step_range ? JSON.parse(row.bin_step_range) : null,
        volatility_range: row.volatility_range ? JSON.parse(row.volatility_range) : null,
        hours_utc: row.hours_utc ? JSON.parse(row.hours_utc) : null,
        evidence: row.evidence ? JSON.parse(row.evidence) : null,
      }));
    }
  } catch (e) {
    log("warn", "postmortem", `Failed to load rules from DB: ${e?.message}`);
  }

  // Fallback: one-time migration from legacy JSON file
  if (!fs.existsSync(POSTMORTEM_FILE)) return [];
  try {
    const legacy = JSON.parse(fs.readFileSync(POSTMORTEM_FILE, "utf8"));
    if (!Array.isArray(legacy) || legacy.length === 0) return [];

    const insert = db.prepare(`
      INSERT OR REPLACE INTO postmortem_rules
        (key, type, strategy, bin_step_range, volatility_range, reason, frequency, count,
         hours_utc, win_rate, sample_size, evidence, severity, description, suggestion, created_at, updated_at)
      VALUES
        (@key, @type, @strategy, @bin_step_range, @volatility_range, @reason, @frequency, @count,
         @hours_utc, @win_rate, @sample_size, @evidence, @severity, @description, @suggestion, @created_at, @updated_at)
    `);
    for (const rule of legacy) {
      insert.run({
        key: rule.key,
        type: rule.type,
        strategy: rule.strategy || null,
        bin_step_range: rule.bin_step_range ? JSON.stringify(rule.bin_step_range) : null,
        volatility_range: rule.volatility_range ? JSON.stringify(rule.volatility_range) : null,
        reason: rule.reason || null,
        frequency: rule.frequency || null,
        count: rule.count || null,
        hours_utc: rule.hours_utc ? JSON.stringify(rule.hours_utc) : null,
        win_rate: rule.win_rate || null,
        sample_size: rule.evidence?.sample_size || null,
        evidence: rule.evidence ? JSON.stringify(rule.evidence) : null,
        severity: rule.severity,
        description: rule.description,
        suggestion: rule.suggestion || null,
        created_at: rule.created_at || new Date().toISOString(),
        updated_at: rule.updated_at || null,
      });
    }
    log("info", "postmortem", `Migrated ${legacy.length} rules from JSON to SQLite`);
    return loadRules(); // re-query DB so returned rules have parsed JSON fields
  } catch (e) {
    log("warn", "postmortem", `Failed to read postmortem JSON fallback: ${e?.message}`);
    return [];
  }
}

/**
 * Save rules to DB, pruning to MAX_RULES most recent.
 * @param {Array} rules
 */
export function saveRules(rules) {
  const db = getDB();
  ensureTable(db);

  const trimmed = rules.slice(-MAX_RULES);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO postmortem_rules
      (key, type, strategy, bin_step_range, volatility_range, reason, frequency, count,
       hours_utc, win_rate, sample_size, evidence, severity, description, suggestion, created_at, updated_at)
    VALUES
      (@key, @type, @strategy, @bin_step_range, @volatility_range, @reason, @frequency, @count,
       @hours_utc, @win_rate, @sample_size, @evidence, @severity, @description, @suggestion, @created_at, @updated_at)
  `);

  runTransaction(() => {
    for (const rule of trimmed) {
      upsert.run({
        key: rule.key,
        type: rule.type,
        strategy: rule.strategy || null,
        bin_step_range: rule.bin_step_range ? JSON.stringify(rule.bin_step_range) : null,
        volatility_range: rule.volatility_range ? JSON.stringify(rule.volatility_range) : null,
        reason: rule.reason || null,
        frequency: rule.frequency || null,
        count: rule.count || null,
        hours_utc: rule.hours_utc ? JSON.stringify(rule.hours_utc) : null,
        win_rate: rule.win_rate || null,
        sample_size: rule.evidence?.sample_size || null,
        evidence: rule.evidence ? JSON.stringify(rule.evidence) : null,
        severity: rule.severity,
        description: rule.description,
        suggestion: rule.suggestion || null,
        created_at: rule.created_at || new Date().toISOString(),
        updated_at: rule.updated_at || null,
      });
    }
    db.prepare(`DELETE FROM postmortem_rules WHERE key NOT IN (SELECT key FROM postmortem_rules ORDER BY created_at DESC LIMIT ${MAX_RULES})`).run();
  });
}

/**
 * Clear all postmortem rules.
 * @returns {{ cleared: boolean }}
 */
export function clearRules() {
  const db = getDB();
  db.prepare("DELETE FROM postmortem_rules").run();
  return { cleared: true };
}