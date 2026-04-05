PRAGMA auto_vacuum = INCREMENTAL;

-- Position state machine: add status column
ALTER TABLE positions ADD COLUMN status TEXT DEFAULT 'active';

-- Migrate smart-wallets JSON to SQLite
CREATE TABLE IF NOT EXISTS smart_wallets (
  address TEXT PRIMARY KEY,
  name TEXT,
  category TEXT DEFAULT 'alpha',
  type TEXT DEFAULT 'lp',
  added_at TEXT
);
