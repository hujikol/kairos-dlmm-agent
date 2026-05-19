/**
 * Migration 008: Cycle outcomes, rejected candidates, and daily snapshots.
 *
 * Adds:
 *   1. cycle_outcomes — records per-cycle stats (candidates seen, filters passed,
 *      LLM/RPC calls, deploy attempts and confirms, PnL at close)
 *   2. rejected_candidates — stores candidates filtered by hard filters with reasons
 *   3. daily_snapshots — lightweight daily aggregate of positions, balance, and PnL
 */

import { tableHasColumn } from "../src/core/db.js";

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_outcomes (
      id               INTEGER   PRIMARY KEY AUTOINCREMENT,
      cycle_type       TEXT      NOT NULL,
      candidates_seen INTEGER   DEFAULT 0,
      filters_passed   INTEGER   DEFAULT 0,
      llm_calls        INTEGER   DEFAULT 0,
      rpc_calls        INTEGER   DEFAULT 0,
      deploy_attempted INTEGER   DEFAULT 0,
      deploy_confirmed INTEGER   DEFAULT 0,
      deploy_position_id TEXT,
      duration_ms      INTEGER,
      pnl_at_close     REAL,
      started_at       TEXT      NOT NULL,
      finalized_at     TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cycle_outcomes_cycle_type ON cycle_outcomes(cycle_type)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cycle_outcomes_started_at ON cycle_outcomes(started_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rejected_candidates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_outcome_id INTEGER,
      pool_address    TEXT,
      rejection_reason TEXT,
      rejected_at     TEXT    NOT NULL,
      FOREIGN KEY (cycle_outcome_id) REFERENCES cycle_outcomes(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rejected_cycle ON rejected_candidates(cycle_outcome_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rejected_pool ON rejected_candidates(pool_address)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date   TEXT    NOT NULL UNIQUE,
      total_positions INTEGER DEFAULT 0,
      total_value_usd REAL,
      total_pnl_realized REAL DEFAULT 0,
      total_pnl_unrealized REAL DEFAULT 0,
      sol_balance     REAL,
      usd_balance     REAL,
      daily_pnl_realized REAL DEFAULT 0,
      cycles_run      INTEGER DEFAULT 0,
      deployments_confirmed INTEGER DEFAULT 0,
      snapshot_at     TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date)
  `);
}
