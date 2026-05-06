/**
 * Migration 005: Add conviction column to positions table
 *
 * Records which conviction level was used when deploying a position.
 * Flows into decision_log at close time for sizing matrix evolution.
 */

import { tableHasColumn } from "../src/core/db.js";

export function migrate(db) {
  if (!tableHasColumn(db, "positions", "conviction")) {
    db.exec(`
      ALTER TABLE positions ADD COLUMN conviction TEXT CHECK (conviction IN ('very_high','high','normal'))
    `);
  }
}
