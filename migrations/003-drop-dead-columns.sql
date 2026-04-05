-- Drop columns that are confirmed dead: 0 reads, 0 logic use, redundant data.
-- SQLite doesn't support DROP COLUMN, so we recreate the affected tables.

BEGIN TRANSACTION;

-- ─── positions: drop initial_fee_tvl_24h ───
-- Always identical to fee_tvl_ratio at deploy. Never used for any logic or comparison.

CREATE TABLE IF NOT EXISTS positions_new (
  position TEXT PRIMARY KEY,
  pool TEXT,
  pool_name TEXT,
  strategy TEXT,
  bin_range TEXT,
  amount_x REAL,
  active_bin_at_deploy INTEGER,
  bin_step INTEGER,
  volatility REAL,
  fee_tvl_ratio REAL,
  organic_score REAL,
  initial_value_usd REAL,
  signal_snapshot TEXT,
  base_mint TEXT,
  deployed_at TEXT,
  out_of_range_since TEXT,
  last_claim_at TEXT,
  total_fees_claimed_usd REAL,
  rebalance_count INTEGER,
  closed INTEGER,
  closed_at TEXT,
  notes TEXT,
  peak_pnl_pct REAL,
  trailing_active INTEGER,
  instruction TEXT,
  status TEXT DEFAULT 'active'
);

INSERT OR IGNORE INTO positions_new (
  position, pool, pool_name, strategy, bin_range, amount_x,
  active_bin_at_deploy, bin_step, volatility, fee_tvl_ratio,
  organic_score, initial_value_usd, signal_snapshot, base_mint,
  deployed_at, out_of_range_since, last_claim_at, total_fees_claimed_usd,
  rebalance_count, closed, closed_at, notes, peak_pnl_pct,
  trailing_active, instruction, status
)
SELECT
  position, pool, pool_name, strategy, bin_range, amount_x,
  active_bin_at_deploy, bin_step, volatility, fee_tvl_ratio,
  organic_score, initial_value_usd, signal_snapshot, base_mint,
  deployed_at, out_of_range_since, last_claim_at, total_fees_claimed_usd,
  rebalance_count, closed, closed_at, notes, peak_pnl_pct,
  trailing_active, instruction, status
FROM positions;

DROP TABLE IF EXISTS positions;
ALTER TABLE positions_new RENAME TO positions;

DROP INDEX IF EXISTS idx_positions_closed;
DROP INDEX IF EXISTS idx_positions_deployed_at;
CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed);
CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at);

-- ─── smart_wallets: drop type, category ───
-- Defaulted to 'lp' / 'alpha', never set to different value or queried.

CREATE TABLE IF NOT EXISTS smart_wallets_new (
  address TEXT PRIMARY KEY,
  name TEXT,
  added_at TEXT
);

INSERT OR IGNORE INTO smart_wallets_new (address, name, added_at)
SELECT address, name, added_at FROM smart_wallets;

DROP TABLE IF EXISTS smart_wallets;
ALTER TABLE smart_wallets_new RENAME TO smart_wallets;

COMMIT;
