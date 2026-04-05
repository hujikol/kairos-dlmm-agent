-- Fix lessons table: id must be TEXT for UUIDs, not INTEGER
-- SQLite doesn't support ALTER COLUMN, so we recreate the table.
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS lessons_new (
  id TEXT PRIMARY KEY,
  rule TEXT,
  tags TEXT,
  outcome TEXT,
  context TEXT,
  pnl_pct REAL,
  range_efficiency REAL,
  pool TEXT,
  created_at TEXT,
  pinned INTEGER DEFAULT 0,
  role TEXT
);

INSERT OR IGNORE INTO lessons_new SELECT
  CAST(id AS TEXT),
  rule, tags, outcome, context, pnl_pct, range_efficiency,
  pool, created_at, pinned, role
FROM lessons;

DROP TABLE IF EXISTS lessons;
ALTER TABLE lessons_new RENAME TO lessons;

COMMIT;
