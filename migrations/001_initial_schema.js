/**
 * Migration 001: Initial Schema
 *
 * Handles both fresh and existing databases:
 * - Fresh DB (no tables): creates all tables from scratch using CREATE TABLE IF NOT EXISTS
 * - Existing DB (has tables): only creates missing tables using CREATE TABLE IF NOT EXISTS
 *   (does not modify existing table schemas — column additions are separate migrations)
 *
 * All CREATE statements use IF NOT EXISTS for absolute safety.
 */

import { tableHasColumn } from "../src/core/db.js";

// ─── Create all tables (fresh DB) ─────────────────────────────────────────────

export function createAllTables(db) {
  // ─── Key-Value Store ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // ─── Positions ─────────────────────────────────────────────────
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

  // ─── Recent Events ──────────────────────────────────────────────
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

  // ─── Performance ────────────────────────────────────────────────
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

  // ─── Lessons ────────────────────────────────────────────────────
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

  // ─── Near Misses ────────────────────────────────────────────────
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

  // ─── Performance Archive ────────────────────────────────────────
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

  // ─── Pool Memory: Summaries ─────────────────────────────────────
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

  // ─── Pool Memory: Deploys ──────────────────────────────────────
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

  // ─── Pool Memory: Snapshots ─────────────────────────────────────
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

  // ─── Strategies ────────────────────────────────────────────────
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

  // ─── Schema Versions ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT
    )
  `);

  // ─── Signal Weights ──────────────────────────────────────────────
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

  // ─── Blacklists ────────────────────────────────────────────────
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

  // ─── Smart Wallets ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_wallets (
      address TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT
    )
  `);

  // ─── Postmortem Rules ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS postmortem_rules (
      key TEXT PRIMARY KEY,
      type TEXT,
      strategy TEXT,
      bin_step_range TEXT,
      volatility_range TEXT,
      reason TEXT,
      frequency INTEGER,
      count INTEGER,
      hours_utc TEXT,
      win_rate INTEGER,
      sample_size INTEGER,
      evidence TEXT,
      severity TEXT,
      description TEXT,
      suggestion TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // ─── Indexes ────────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)`);
}

// ─── Migrate existing DB (add missing tables only) ────────────────────────────

export function migrateExisting(db, existingTables) {
  const existingSet = new Set(existingTables.map(t => t.name));

  // Ensure _schema_versions exists first
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT
    )
  `);

  // Define all tables that should exist
  const requiredTables = [
    "kv_store",
    "positions",
    "recent_events",
    "performance",
    "lessons",
    "near_misses",
    "performance_archive",
    "pool_memory",
    "pool_deploys",
    "pool_snapshots",
    "strategies",
    "_schema_versions",
    "signal_weights",
    "signal_weights_history",
    "token_blacklist",
    "dev_blocklist",
    "smart_wallets",
    "postmortem_rules",
  ];

  // Only CREATE TABLE IF NOT EXISTS for missing tables
  for (const table of requiredTables) {
    if (!existingSet.has(table)) {
      createMissingTable(db, table);
    }
  }

  // Create indexes if missing (idempotent)
  const existingIndexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
  ).all().map(i => i.name);

  const requiredIndexes = [
    { name: "idx_pool_deploys_pool", sql: "CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address)" },
    { name: "idx_pool_snapshots_pool", sql: "CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool ON pool_snapshots(pool_address)" },
    { name: "idx_positions_closed", sql: "CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed)" },
    { name: "idx_positions_deployed_at", sql: "CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at)" },
    { name: "idx_performance_recorded_at", sql: "CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at)" },
    { name: "idx_lessons_role", sql: "CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)" },
    { name: "idx_lessons_outcome", sql: "CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)" },
  ];

  const existingIndexSet = new Set(existingIndexes);
  for (const idx of requiredIndexes) {
    if (!existingIndexSet.has(idx.name)) {
      db.exec(idx.sql);
    }
  }
}

function createMissingTable(db, tableName) {
  const creators = {
    kv_store: `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`,

    positions: `CREATE TABLE IF NOT EXISTS positions (
      position TEXT PRIMARY KEY, pool TEXT, pool_name TEXT, strategy TEXT,
      bin_range TEXT, amount_sol REAL, amount_x REAL, active_bin_at_deploy INTEGER,
      bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL, organic_score REAL,
      initial_value_usd REAL, signal_snapshot TEXT, base_mint TEXT, deployed_at TEXT,
      out_of_range_since TEXT, last_claim_at TEXT, total_fees_claimed_usd REAL,
      rebalance_count INTEGER, closed INTEGER DEFAULT 0, closed_at TEXT, notes TEXT,
      peak_pnl_pct REAL, prev_pnl_pct REAL, trailing_active INTEGER DEFAULT 0,
      instruction TEXT, status TEXT DEFAULT 'active', market_phase TEXT, strategy_id TEXT
    )`,

    recent_events: `CREATE TABLE IF NOT EXISTS recent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT, position TEXT,
      pool_name TEXT, reason TEXT
    )`,

    performance: `CREATE TABLE IF NOT EXISTS performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, position TEXT, pool TEXT, pool_name TEXT,
      strategy TEXT, bin_range TEXT, bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL,
      organic_score REAL, amount_sol REAL, fees_earned_usd REAL, final_value_usd REAL,
      initial_value_usd REAL, minutes_in_range REAL, minutes_held REAL, close_reason TEXT,
      pnl_usd REAL, pnl_pct REAL, range_efficiency REAL, deployed_at TEXT, closed_at TEXT,
      recorded_at TEXT, base_mint TEXT
    )`,

    lessons: `CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY, rule TEXT, tags TEXT, outcome TEXT, context TEXT,
      pnl_pct REAL, range_efficiency REAL, pool TEXT, created_at TEXT,
      pinned INTEGER DEFAULT 0, role TEXT, rating TEXT, rating_at TEXT
    )`,

    near_misses: `CREATE TABLE IF NOT EXISTS near_misses (
      id TEXT PRIMARY KEY, position TEXT, pool TEXT, strategy TEXT, bin_step INTEGER,
      volatility REAL, fee_tvl_ratio REAL, organic_score REAL, pnl_usd REAL, pnl_pct REAL,
      minutes_in_range REAL, minutes_held REAL, range_efficiency REAL, close_reason TEXT,
      created_at TEXT, reviewed INTEGER DEFAULT 0
    )`,

    performance_archive: `CREATE TABLE IF NOT EXISTS performance_archive (
      id INTEGER PRIMARY KEY, position TEXT, pool TEXT, pool_name TEXT, strategy TEXT,
      bin_range TEXT, bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL, organic_score REAL,
      amount_sol REAL, fees_earned_usd REAL, final_value_usd REAL, initial_value_usd REAL,
      minutes_in_range REAL, minutes_held REAL, close_reason TEXT, pnl_usd REAL, pnl_pct REAL,
      range_efficiency REAL, deployed_at TEXT, closed_at TEXT, recorded_at TEXT, base_mint TEXT,
      archived_at TEXT
    )`,

    pool_memory: `CREATE TABLE IF NOT EXISTS pool_memory (
      pool_address TEXT PRIMARY KEY, name TEXT, base_mint TEXT, total_deploys INTEGER,
      avg_pnl_pct REAL, win_rate REAL, last_deployed_at TEXT, last_outcome TEXT,
      notes TEXT, cooldown_until TEXT
    )`,

    pool_deploys: `CREATE TABLE IF NOT EXISTS pool_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pool_address TEXT, deployed_at TEXT, closed_at TEXT,
      pnl_pct REAL, pnl_usd REAL, range_efficiency REAL, minutes_held REAL, close_reason TEXT,
      strategy TEXT, volatility_at_deploy REAL,
      FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
    )`,

    pool_snapshots: `CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pool_address TEXT, ts TEXT, position TEXT,
      pnl_pct REAL, pnl_usd REAL, in_range INTEGER, unclaimed_fees_usd REAL,
      minutes_out_of_range INTEGER, age_minutes REAL,
      FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
    )`,

    strategies: `CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY, name TEXT, author TEXT, lp_strategy TEXT, token_criteria TEXT,
      entry TEXT, range TEXT, exit TEXT, best_for TEXT, raw TEXT, added_at TEXT, updated_at TEXT
    )`,

    _schema_versions: `CREATE TABLE IF NOT EXISTS _schema_versions (
      version INTEGER PRIMARY KEY, applied_at TEXT
    )`,

    signal_weights: `CREATE TABLE IF NOT EXISTS signal_weights (
      id INTEGER PRIMARY KEY DEFAULT 1, weights TEXT, last_recalc TEXT, recalc_count INTEGER
    )`,

    signal_weights_history: `CREATE TABLE IF NOT EXISTS signal_weights_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, changes TEXT, window_size INTEGER,
      win_count INTEGER, loss_count INTEGER
    )`,

    token_blacklist: `CREATE TABLE IF NOT EXISTS token_blacklist (
      mint TEXT PRIMARY KEY, symbol TEXT, reason TEXT, added_at TEXT, added_by TEXT
    )`,

    dev_blocklist: `CREATE TABLE IF NOT EXISTS dev_blocklist (
      wallet TEXT PRIMARY KEY, label TEXT, reason TEXT, added_at TEXT
    )`,

    smart_wallets: `CREATE TABLE IF NOT EXISTS smart_wallets (
      address TEXT PRIMARY KEY, name TEXT, added_at TEXT
    )`,

    postmortem_rules: `CREATE TABLE IF NOT EXISTS postmortem_rules (
      key TEXT PRIMARY KEY, type TEXT, strategy TEXT, bin_step_range TEXT, volatility_range TEXT,
      reason TEXT, frequency INTEGER, count INTEGER, hours_utc TEXT, win_rate INTEGER,
      sample_size INTEGER, evidence TEXT, severity TEXT, description TEXT, suggestion TEXT,
      created_at TEXT, updated_at TEXT
    )`,
  };

  if (creators[tableName]) {
    db.exec(creators[tableName]);
  }
}

// ─── Main migrate function ────────────────────────────────────────────────────

export function migrate(db) {
  // Check if this is a fresh DB (no tables) or existing DB
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();

  if (tables.length === 0) {
    // Fresh DB — create all tables
    createAllTables(db);
  } else {
    // Existing DB — ensure all core tables exist (CREATE IF NOT EXISTS is idempotent)
    // This catches DBs that pre-date the migration system or have partial schemas
    createAllTables(db);
    // Run migrations for schema changes that go beyond CREATE TABLE
    migrateExisting(db, tables);
  }
}