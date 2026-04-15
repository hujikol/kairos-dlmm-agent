/**
 * Migration 002: Add Missing Columns
 *
 * Adds any columns that are documented in ARCHITECTURE.md but may not exist
 * in existing databases that were created before Phase 13 schema updates.
 *
 * SQLite does not support ADD COLUMN IF NOT EXISTS, so we use PRAGMA table_info
 * to check before altering.
 */

import { tableHasColumn } from "../src/core/db.js";

export function migrate(db) {
  const alterations = [];

  // ─── strategies table: Phase 13 columns ───────────────────────────────────
  const strategyColumns = [
    {
      name: "phase",
      sql: `ALTER TABLE strategies ADD COLUMN phase TEXT CHECK (phase IN ('any','pump','pullback','runner','bear','bull','consolidation'))`,
    },
    {
      name: "bin_count",
      sql: `ALTER TABLE strategies ADD COLUMN bin_count INTEGER`,
    },
    {
      name: "fee_tier_target",
      sql: `ALTER TABLE strategies ADD COLUMN fee_tier_target REAL`,
    },
    {
      name: "max_hold_hours",
      sql: `ALTER TABLE strategies ADD COLUMN max_hold_hours INTEGER`,
    },
    {
      name: "confidence",
      sql: `ALTER TABLE strategies ADD COLUMN confidence INTEGER DEFAULT 0`,
    },
  ];

  for (const col of strategyColumns) {
    if (!tableHasColumn(db, "strategies", col.name)) {
      alterations.push(col.sql);
    }
  }

  // ─── positions table: check for market_phase and strategy_id ──────────────
  // (These should already be in positions table from 001 schema, but we check
  // in case an existing DB was on a very old version)
  const positionColumns = [
    {
      name: "market_phase",
      sql: `ALTER TABLE positions ADD COLUMN market_phase TEXT`,
    },
    {
      name: "strategy_id",
      sql: `ALTER TABLE positions ADD COLUMN strategy_id TEXT`,
    },
  ];

  for (const col of positionColumns) {
    if (!tableHasColumn(db, "positions", col.name)) {
      alterations.push(col.sql);
    }
  }

  // Apply all alterations, wrapped in a single transaction
  if (alterations.length > 0) {
    db.transaction(() => {
      for (const sql of alterations) {
        try {
          db.exec(sql);
        } catch (e) {
          // Column might already exist (race condition or already applied)
          // SQLite error for duplicate column is: "duplicate column name"
          if (!e.message.includes("duplicate column name")) {
            throw e;
          }
        }
      }
    })();
  }
}