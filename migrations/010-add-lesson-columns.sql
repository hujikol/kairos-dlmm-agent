-- Phase 10: Add near_misses table, performance_archive table
-- and lessons column extensions for rating + near_misses

CREATE TABLE IF NOT EXISTS near_misses (
  id TEXT PRIMARY KEY,
  position TEXT,
  pool TEXT,
  strategy TEXT,
  bin_step INTEGER,
  volatility REAL,
  fee_tvl_ratio REAL,
  organic_score REAL,
  pnl_usd REAL,
  pnl_pct REAL,
  minutes_in_range REAL,
  minutes_held REAL,
  range_efficiency REAL,
  close_reason TEXT,
  created_at TEXT,
  reviewed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS performance_archive (
  id INTEGER PRIMARY KEY,
  position TEXT,
  pool TEXT,
  pool_name TEXT,
  strategy TEXT,
  bin_range TEXT,
  bin_step INTEGER,
  volatility REAL,
  fee_tvl_ratio REAL,
  organic_score REAL,
  amount_sol REAL,
  fees_earned_usd REAL,
  final_value_usd REAL,
  initial_value_usd REAL,
  minutes_in_range REAL,
  minutes_held REAL,
  close_reason TEXT,
  pnl_usd REAL,
  pnl_pct REAL,
  range_efficiency REAL,
  deployed_at TEXT,
  closed_at TEXT,
  recorded_at TEXT,
  base_mint TEXT,
  archived_at TEXT
);

-- Add rating columns to lessons (nullable ALTER for existing tables)
ALTER TABLE lessons ADD COLUMN rating TEXT;
ALTER TABLE lessons ADD COLUMN rating_at TEXT;
