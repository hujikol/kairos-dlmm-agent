/**
 * Migration 003: Add decision_log table
 */

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT,
      type            TEXT,
      pool_address    TEXT,
      pool_name       TEXT,
      position_address TEXT,
      amount_sol      REAL,
      pnl_usd         REAL,
      pnl_pct         REAL,
      reasoning       TEXT,
      metadata        TEXT,
      initiated_by    TEXT,
      bin_step        REAL,
      volatility      REAL,
      fee_tvl_ratio   REAL,
      organic_score   REAL,
      strategy        TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_timestamp ON decision_log(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_type ON decision_log(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_pool ON decision_log(pool_address)`);
}
