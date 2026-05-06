/**
 * In-memory better-sqlite3 wrapper for unit tests.
 * Provides the same interface that _extendDb in db.js expects.
 */

import Database from "better-sqlite3";

/**
 * Create an in-memory better-sqlite3 database.
 * Returns a wrapper that provides the interface db.js expects.
 */
export async function makeMemDB() {
  const db = new Database(":memory:");

  // Wrapper that provides the interface _extendDb expects
  const wrapper = {
    // _extendDb does: _rawRun = _db.run.bind(_db)
    // So we need a run method that takes (sql, ...params)
    run(sql, ...params) {
      db.prepare(sql).run(...params);
      return { changes: db.pragma("changes"), lastInsertRowid: 0 };
    },

    // _extendDb does: _rawPrepare = _db.prepare.bind(_db)
    // So we need a prepare method that returns a statement with run/get/all
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          stmt.run(...params);
          return { changes: db.pragma("changes"), lastInsertRowid: 0 };
        },
        get(...params) {
          return stmt.get(...params) || null;
        },
        all(...params) {
          return stmt.all(...params) || [];
        },
      };
    },

    // Other methods db.js might use
    exec(sql) {
      db.exec(sql);
    },

    close() {
      db.close();
    },

    transaction(fn) {
      // Execute immediately — better-sqlite3's db.transaction(fn) returns a callable
      // Statement wrapper; calling it with () runs the transaction and returns undefined.
      // Matching better-sqlite3 semantics: const rows = db.transaction(fn)() — the
      // outer () is what executes, not a separate wrapper object.
      return db.transaction(fn)();
    },

    // pragma support (better-sqlite3 style)
    pragma(name) {
      return db.pragma(name);
    },

    // Expose underlying better-sqlite3 db directly.
    // Some tests (test-evolve.js) need full better-sqlite3 API including transaction().
    _db: db,
  };

  return wrapper;
}

/**
 * Create a fully initialized in-memory DB with schema, suitable for registry tests.
 */
export async function makeSchemaDB() {
  const db = await makeMemDB();

  // Apply schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS positions (
      position TEXT PRIMARY KEY, pool TEXT, pool_name TEXT, strategy TEXT,
      bin_range TEXT, amount_sol REAL, amount_x REAL, active_bin_at_deploy INTEGER,
      bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL, organic_score REAL,
      initial_value_usd REAL, signal_snapshot TEXT, base_mint TEXT, deployed_at TEXT,
      out_of_range_since TEXT, last_claim_at TEXT, total_fees_claimed_usd REAL,
      rebalance_count INTEGER DEFAULT 0, closed INTEGER DEFAULT 0, closed_at TEXT,
      notes TEXT DEFAULT '[]', peak_pnl_pct REAL, prev_pnl_pct REAL,
      trailing_active INTEGER DEFAULT 0, instruction TEXT, status TEXT DEFAULT 'active',
      market_phase TEXT, strategy_id TEXT
    );
    CREATE TABLE IF NOT EXISTS recent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT,
      position TEXT, pool_name TEXT, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, position TEXT, pool TEXT, pool_name TEXT,
      strategy TEXT, bin_range TEXT, bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL,
      organic_score REAL, amount_sol REAL, fees_earned_usd REAL, final_value_usd REAL,
      initial_value_usd REAL, minutes_in_range REAL, minutes_held REAL, close_reason TEXT,
      pnl_usd REAL, pnl_pct REAL, range_efficiency REAL, deployed_at TEXT, closed_at TEXT,
      recorded_at TEXT, base_mint TEXT
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY, rule TEXT, tags TEXT, outcome TEXT, context TEXT,
      pnl_pct REAL, range_efficiency REAL, pool TEXT, created_at TEXT,
      pinned INTEGER DEFAULT 0, role TEXT, rating TEXT, rating_at TEXT
    );
    CREATE TABLE IF NOT EXISTS oor_registry (
      position TEXT PRIMARY KEY, pool TEXT, detected_at TEXT,
      oor_since TEXT, last_checked_at TEXT, evicted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS evolver_state (
      key TEXT PRIMARY KEY, value TEXT
    );
  `);

  return db;
}
