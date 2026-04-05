PRAGMA auto_vacuum = INCREMENTAL;

-- Migrate smart-wallets JSON to SQLite
CREATE TABLE IF NOT EXISTS smart_wallets (
  address TEXT PRIMARY KEY,
  name TEXT,
  category TEXT DEFAULT 'alpha',
  type TEXT DEFAULT 'lp',
  added_at TEXT
);
