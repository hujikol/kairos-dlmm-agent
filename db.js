import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "meridian.db");

let _db = null;

export function getDB() {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL"); // Better performance with WAL

  // Initialize schema
  initSchema(_db);
  
  return _db;
}

function initSchema(db) {
  // ─── Key-Value Store (for _lastBriefingDate, lastUpdated, etc) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // ─── State: Positions ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      position TEXT PRIMARY KEY,
      pool TEXT,
      pool_name TEXT,
      strategy TEXT,
      bin_range TEXT, -- JSON
      amount_sol REAL,
      amount_x REAL,
      active_bin_at_deploy INTEGER,
      bin_step INTEGER,
      volatility REAL,
      fee_tvl_ratio REAL,
      initial_fee_tvl_24h REAL,
      organic_score REAL,
      initial_value_usd REAL,
      signal_snapshot TEXT, -- JSON
      base_mint TEXT,
      deployed_at TEXT,
      out_of_range_since TEXT,
      last_claim_at TEXT,
      total_fees_claimed_usd REAL,
      rebalance_count INTEGER,
      closed INTEGER, -- BOOLEAN (0 or 1)
      closed_at TEXT,
      notes TEXT, -- JSON array of strings
      peak_pnl_pct REAL,
      trailing_active INTEGER, -- BOOLEAN
      instruction TEXT
    )
  `);

  // ─── State: Recent Events ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      action TEXT,
      position TEXT,
      pool_name TEXT,
      reason TEXT
    )
  `);

  // ─── Lessons: Performance ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      base_mint TEXT
    )
  `);

  // ─── Lessons: Lessons ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY, -- Using explicit timestamp IDs as before
      rule TEXT,
      tags TEXT, -- JSON
      outcome TEXT,
      context TEXT,
      pnl_pct REAL,
      range_efficiency REAL,
      pool TEXT,
      created_at TEXT,
      pinned INTEGER DEFAULT 0, -- BOOLEAN
      role TEXT
    )
  `);

  // ─── Pool Memory: Summaries ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_memory (
      pool_address TEXT PRIMARY KEY,
      name TEXT,
      base_mint TEXT,
      total_deploys INTEGER,
      avg_pnl_pct REAL,
      win_rate REAL,
      last_deployed_at TEXT,
      last_outcome TEXT,
      notes TEXT, -- JSON array of objects { note, added_at }
      cooldown_until TEXT
    )
  `);

  // ─── Pool Memory: Deploys ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT,
      deployed_at TEXT,
      closed_at TEXT,
      pnl_pct REAL,
      pnl_usd REAL,
      range_efficiency REAL,
      minutes_held REAL,
      close_reason TEXT,
      strategy TEXT,
      volatility_at_deploy REAL,
      FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address)`);

  // ─── Pool Memory: Snapshots ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT,
      ts TEXT,
      position TEXT,
      pnl_pct REAL,
      pnl_usd REAL,
      in_range INTEGER, -- BOOLEAN
      unclaimed_fees_usd REAL,
      minutes_out_of_range INTEGER,
      age_minutes REAL,
      FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool ON pool_snapshots(pool_address)`);
}

/**
 * Shut down the db cleanly
 */
export function closeDB() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
