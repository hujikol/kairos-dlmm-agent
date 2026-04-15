import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { MIGRATIONS } from "../../migrations/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "meridian.db");

let _db = null;

export function getDB() {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL"); // Better performance with WAL
  _db.pragma("foreign_keys = ON"); // Enforce FK constraints

  // Run migrations first (handles both fresh and existing DBs)
  migrate(_db);

  // Initialize additional schema (backward compat — all tables created via migrations now)
  initSchema(_db);

  return _db;
}

// ─── Test injection ───────────────────────────────────────────────────────────

/** Inject a test database instance (for unit tests only). */
export function _injectDB(db) {
  if (_db && _db !== db) _db.close();
  _db = db;
}

// ─── Schema Migration Runner ──────────────────────────────────────────────────

export function migrate(db) {
  // Ensure _schema_versions table exists first
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT
    )
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM _schema_versions").all().map(r => r.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.fn(db);
      db.prepare(
        "INSERT INTO _schema_versions (version, applied_at) VALUES (?, ?)"
      ).run(migration.id, new Date().toISOString());
      log("info", "db", `Applied migration #${migration.id} (${migration.name})`);
    })();
  }
}

// ─── Utility: Check if a column exists in a table ─────────────────────────────

export function tableHasColumn(db, table, column) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some(col => col.name === column);
}

// ─── initSchema: backward-compatible table creation ──────────────────────────

export function initSchema(db) {
  // Key-Value Store
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Positions
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      position TEXT PRIMARY KEY,
      pool TEXT,
      pool_name TEXT,
      strategy TEXT,
      bin_range TEXT,
      amount_sol REAL,
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
      closed INTEGER DEFAULT 0,
      closed_at TEXT,
      notes TEXT,
      peak_pnl_pct REAL,
      prev_pnl_pct REAL,
      trailing_active INTEGER DEFAULT 0,
      instruction TEXT,
      status TEXT DEFAULT 'active',
      market_phase TEXT,
      strategy_id TEXT
    )
  `);

  // Recent Events
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

  // Performance
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

  // Lessons
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
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
      role TEXT,
      rating TEXT,
      rating_at TEXT
    )
  `);

  // Near Misses
  db.exec(`
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
    )
  `);

  // Performance Archive
  db.exec(`
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
    )
  `);

  // Pool Memory: Summaries
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
      notes TEXT,
      cooldown_until TEXT
    )
  `);

  // Pool Memory: Deploys
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

  // Pool Memory: Snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT,
      ts TEXT,
      position TEXT,
      pnl_pct REAL,
      pnl_usd REAL,
      in_range INTEGER,
      unclaimed_fees_usd REAL,
      minutes_out_of_range INTEGER,
      age_minutes REAL,
      FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool ON pool_snapshots(pool_address)`);

  // Strategies
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT,
      author TEXT,
      lp_strategy TEXT,
      token_criteria TEXT,
      entry TEXT,
      range TEXT,
      exit TEXT,
      best_for TEXT,
      raw TEXT,
      added_at TEXT,
      updated_at TEXT
    )
  `);

  // Signal Weights
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weights (
      id INTEGER PRIMARY KEY DEFAULT 1,
      weights TEXT,
      last_recalc TEXT,
      recalc_count INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weights_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      changes TEXT,
      window_size INTEGER,
      win_count INTEGER,
      loss_count INTEGER
    )
  `);

  // Blacklists
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_blacklist (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      reason TEXT,
      added_at TEXT,
      added_by TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_blocklist (
      wallet TEXT PRIMARY KEY,
      label TEXT,
      reason TEXT,
      added_at TEXT
    )
  `);

  // Smart Wallets
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_wallets (
      address TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT
    )
  `);

  // Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)`);
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

/**
 * Validate an ISO 8601 timestamp string.
 */
export function isValidISO(str) {
  if (typeof str !== "string") return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}