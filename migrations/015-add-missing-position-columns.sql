-- Migration 001: Add missing columns to positions table
-- These columns were added to the initSchema but pre-existing DBs were missing them.
-- NOTE: SQLite does not support IF NOT EXISTS on ALTER TABLE.
-- The runMigrations() runner in db.js will skip this file entirely if it has
-- already been applied (tracked in the migrations table), so duplicate-column
-- errors cannot occur after the first successful run.

ALTER TABLE positions ADD COLUMN amount_sol REAL;
ALTER TABLE positions ADD COLUMN market_phase TEXT;
ALTER TABLE positions ADD COLUMN strategy_id TEXT;
