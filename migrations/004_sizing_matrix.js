/**
 * Migration 004: Evolving Conviction Sizing Matrix
 *
 * Adds:
 * - conviction column to decision_log (captures which conviction level was used at deploy time)
 * - sizing_matrix table (stores evolving multipliers per conviction level and position count)
 * - sizing_matrix_history table (audit trail of changes)
 */

import { tableHasColumn } from "../src/core/db.js";

export function migrate(db) {
  const alterations = [];

  // ─── decision_log: add conviction column ───────────────────────────
  if (!tableHasColumn(db, "decision_log", "conviction")) {
    alterations.push(
      `ALTER TABLE decision_log ADD COLUMN conviction TEXT CHECK (conviction IN ('very_high','high','normal'))`
    );
  }

  // ─── sizing_matrix table ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sizing_matrix (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      -- Conviction level as JSON key: { "very_high": { "0": 1.5, ... }, "high": {...}, "normal": {...} }
      matrix          TEXT,
      last_evolved    TEXT,
      evolve_count    INTEGER DEFAULT 0
    )
  `);

  // ─── sizing_matrix_history table ──────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sizing_matrix_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT,
      changes         TEXT,
      window_days     INTEGER,
      total_records   INTEGER,
      win_rate        REAL
    )
  `);

  // Apply column alterations
  if (alterations.length > 0) {
    db.exec("BEGIN");
    try {
      for (const sql of alterations) {
        try {
          db.exec(sql);
        } catch (e) {
          if (!e.message.includes("duplicate column name")) {
            throw e;
          }
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
