import fs from "fs";
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
  _db.pragma("foreign_keys = ON"); // Enforce FK constraints

  // Initialize schema + migrations
  initSchema(_db);
  runMigrations(_db);
  
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
      bin_range TEXT,
      amount_sol REAL,
      amount_x REAL,
      active_bin_at_deploy INTEGER,
      bin_step INTEGER,
      volatility REAL,
      fee_tvl_ratio REAL,
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
      instruction TEXT,
      status TEXT DEFAULT 'active', -- 'pending' -> 'active' -> 'closed'
      market_phase TEXT,
      strategy_id TEXT
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
  // id is TEXT (UUID) — lessons.js generates IDs with crypto.randomUUID()
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      rule TEXT,
      tags TEXT, -- JSON
      outcome TEXT,
      context TEXT,
      pnl_pct REAL,
      range_efficiency REAL,
      pool TEXT,
      created_at TEXT,
      pinned INTEGER DEFAULT 0, -- BOOLEAN
      role TEXT,
      rating TEXT, -- 'useful' | 'useless'
      rating_at TEXT
    )
  `);

  // ─── Near Misses (neutral outcomes: -5% < pnl < 5%) ───
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

  // ─── Performance Archive (pruned from performance table) ───
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

  // ─── Performance indexes ───
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)`);

  // ─── Strategies ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT,
      author TEXT,
      lp_strategy TEXT,
      token_criteria TEXT, -- JSON
      entry TEXT, -- JSON
      range TEXT, -- JSON
      exit TEXT, -- JSON
      best_for TEXT,
      raw TEXT,
      added_at TEXT,
      updated_at TEXT
    )
  `);

  // ─── Strategies: Phase 13 columns (nullable — ALTER for existing tables) ───
  const phaseCols = db.prepare("PRAGMA table_info(strategies)").all();
  const hasCol = (name) => phaseCols.some(c => c.name === name);
  if (!hasCol('phase')) db.exec(`ALTER TABLE strategies ADD COLUMN phase TEXT CHECK (phase IN ('any','pump','pullback','runner','bear','bull','consolidation'))`);
  if (!hasCol('bin_count')) db.exec(`ALTER TABLE strategies ADD COLUMN bin_count INTEGER`);
  if (!hasCol('fee_tier_target')) db.exec(`ALTER TABLE strategies ADD COLUMN fee_tier_target REAL`);
  if (!hasCol('max_hold_hours')) db.exec(`ALTER TABLE strategies ADD COLUMN max_hold_hours INTEGER`);
  if (!hasCol('confidence')) db.exec(`ALTER TABLE strategies ADD COLUMN confidence INTEGER DEFAULT 0`);

  // ─── Signal Weights ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weights (
      id INTEGER PRIMARY KEY DEFAULT 1, -- Only one record for current weights
      weights TEXT, -- JSON
      last_recalc TEXT,
      recalc_count INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weights_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      changes TEXT, -- JSON
      window_size INTEGER,
      win_count INTEGER,
      loss_count INTEGER
    )
  `);

  // ─── Blacklists ───
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

  // ─── Smart Wallets ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_wallets (
      address TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT
    )
  `);
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

// ─── Migration system ──────────────────────────────────────────

/**
 * Apply forward-only migrations from the migrations/ directory.
 * Simple approach: track applied migrations in a table, run each once.
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = db.prepare('SELECT name FROM migrations').all().map(r => r.name);

  try {
    const migrationsDir = path.join(__dirname, "../migrations");
    if (!fs.existsSync(migrationsDir)) return;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.includes(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
      log("info", "migration", `Applied migration: ${file}`);
    }
  } catch (e) {
    // migrations dir may not exist — not fatal
    log("warn", "migration", `Migration scan failed: ${e.message}`);
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
