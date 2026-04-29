/**
 * In-memory sql.js wrapper for unit tests.
 * Provides the synchronous-like interface expected by _injectDB.
 * Run inside an async context to allow WASM initialization.
 */

import initSqlJs from "sql.js";

/**
 * Build an in-memory sql.js database, initialized and ready for _injectDB.
 * The DB is empty (no schema) — call initSchema() after injecting if needed.
 */
export async function makeMemDB() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  const wrapper = {
    transaction(fn) {
      return () => {
        db.run("BEGIN TRANSACTION");
        try {
          fn.call(wrapper);
          db.run("COMMIT");
        } catch (e) {
          db.run("ROLLBACK");
          throw e;
        }
      };
    },

    prepare(sql) {
      const upper = sql.trim().toUpperCase();

      if (upper.startsWith("INSERT") || upper.startsWith("UPDATE") || upper.startsWith("DELETE")) {
        const stmt = {
          _runArgs: null,
          bind(...vals) { this._runArgs = vals; return stmt; },
          step() { return false; },
          run(...vals) { db.run(sql, vals.length ? vals : this._runArgs || []); },
          get() { return null; },
          free() {},
          reset() {},
          getRowsModified: () => db.getRowsModified(),
        };
        return stmt;
      }

      if (upper.startsWith("SELECT")) {
        // Use real sql.js prepared statement to get proper bind/step/get interface
        const rawStmt = db.prepare(sql);
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        const tableName = tableMatch ? tableMatch[1] : null;

        return {
          bind(...vals) { rawStmt.bind(vals); return this; },
          step() {
            // Check overlay first for test data injection
            const overlay = wrapper._testRows.get(tableName);
            if (overlay && overlay.length > 0) {
              rawStmt.bind([]);  // Bind empty — overlay uses no params
              wrapper._resultRow = 0;
              return true;
            }
            return rawStmt.step();
          },
          get() {
            const overlay = wrapper._testRows.get(tableName);
            if (overlay && overlay.length > 0) {
              return overlay[wrapper._resultRow++] || null;
            }
            return rawStmt.step() ? rawStmt.getAsObject() : null;
          },
          free() { rawStmt.free(); },
          reset() { wrapper._resultRow = 0; rawStmt.reset(); },
          getAsObject() { return rawStmt.getAsObject(); },
          _raw: rawStmt,
          _resultRow: 0,
        };
      }

      // DDL / other
      const stmt = {
        bind() { return stmt; },
        step() { return false; },
        run() { db.run(sql); },
        get() { return null; },
        free() {},
        reset() {},
      };
      return stmt;
    },

    exec(sql) {
      db.run(sql);
    },

    run(sql, ...vals) {
      db.run(sql, vals);
    },

    close() {
      // no-op for in-memory test wrapper
    },

    export() {
      return db.export();
    },

    // Internal — overlay test data for SELECT queries
    _testRows: new Map(),

    // Inject test rows for a given table (e.g. "positions")
    _injectRows(table, rows) {
      this._testRows.set(table, rows);
    },

    // Direct passthrough to underlying db for migrations
    _db: db,
  };

  return wrapper;
}

/**
 * Create a fully initialized in-memory DB with schema, suitable for registry tests.
 */
export async function makeSchemaDB() {
  const { initSchema: _initSchema } = await import("../src/core/db.js");
  const db = await makeMemDB();
  // Apply full schema
  db.exec(`
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE positions (
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
    CREATE TABLE recent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT, position TEXT,
      pool_name TEXT, reason TEXT
    );
    CREATE TABLE performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, position TEXT, pool TEXT, pool_name TEXT,
      strategy TEXT, bin_range TEXT, bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL,
      organic_score REAL, amount_sol REAL, fees_earned_usd REAL, final_value_usd REAL,
      initial_value_usd REAL, minutes_in_range REAL, minutes_held REAL, close_reason TEXT,
      pnl_usd REAL, pnl_pct REAL, range_efficiency REAL, deployed_at TEXT, closed_at TEXT,
      recorded_at TEXT, base_mint TEXT
    );
    CREATE TABLE pool_memory (
      pool_address TEXT PRIMARY KEY, name TEXT, base_mint TEXT, total_deploys INTEGER,
      avg_pnl_pct REAL, win_rate REAL, last_deployed_at TEXT, last_outcome TEXT,
      notes TEXT, cooldown_until TEXT
    );
    -- Seed schema versions so migrate() skips all migrations (DB already has full schema)
    CREATE TABLE _schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO _schema_versions VALUES (1, '2026-01-01T00:00:00.000Z');
    INSERT INTO _schema_versions VALUES (2, '2026-01-01T00:00:00.000Z');
    INSERT INTO _schema_versions VALUES (3, '2026-01-01T00:00:00.000Z');
  `);
  return db;
}
