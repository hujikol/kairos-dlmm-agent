/**
 * Migration 007: Ensure strategies table is complete.
 *
 * The strategies table was added in v2.1.0 (feature: strategy-library.js).
 * On fresh DBs it is created by createAllTables() in migration 001.
 * On existing DBs that pre-date this feature, the table may not exist
 * or may be missing the `raw` column.
 *
 * This migration ensures:
 *   1. The strategies table exists with all required columns
 *   2. The `raw` column has a DEFAULT so INSERTs don't bind undefined
 *
 * up(): ensures strategies table + raw column exist
 * down(): no-op — table structure is harmless to keep
 */

import { tableHasColumn } from "../src/core/db.js";

export function up(db) {
  // Ensure the table itself exists (idempotent — CREATE TABLE IF NOT EXISTS)
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT,
      author TEXT,
      lp_strategy TEXT,
      token_criteria TEXT,
      entry TEXT,
      range TEXT,
      exit TEXT,
      best_for TEXT,
      raw TEXT DEFAULT NULL,
      added_at TEXT,
      updated_at TEXT
    )
  `);

  // Ensure raw column exists with DEFAULT NULL (added in v2.1.0)
  if (!tableHasColumn(db, "strategies", "raw")) {
    try {
      db.exec("ALTER TABLE strategies ADD COLUMN raw TEXT DEFAULT NULL");
    } catch (err) {
      // Ignore "duplicate column" — table already has raw from a prior run
      if (!err?.message?.includes("duplicate column")) throw err;
    }
  }
}

export function down(db) {
  // no-op — table structure is harmless to keep; dropping achieves nothing
}
