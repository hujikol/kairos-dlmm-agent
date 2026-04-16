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

  // Wrap the WASM db to expose synchronous-looking prepare() interface.
  // sql.js's db.exec() returns results but prepare() is not synchronous.
  // We simulate the sync prepare interface that registry.js uses.
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
        return {
          run(...vals) {
            db.run(sql, vals);
          },
          get(...vals) { return null; },
          all(...vals) { return []; },
        };
      }

      if (upper.startsWith("SELECT")) {
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        const tableName = tableMatch ? tableMatch[1] : null;

        return {
          run(...vals) { db.run(sql, vals); },
          get(...vals) {
            const overlay = _testRows.get(tableName);
            if (!overlay) {
              try {
                const res = db.exec(sql, vals);
                if (!res.length || !res[0].values.length) return null;
                const cols = res[0].columns;
                const vals2 = res[0].values[0];
                return Object.fromEntries(cols.map((c, i) => [c, vals2[i]]));
              } catch { return null; }
            }
            if (tableName && vals[0] !== undefined) {
              const row = overlay.find(r => r.position === vals[0]);
              return row || null;
            }
            return overlay[0] || null;
          },
          all(...vals) {
            const overlay = _testRows.get(tableName);
            if (overlay) return overlay;
            try {
              const res = db.exec(sql, vals);
              if (!res.length) return [];
              const cols = res[0].columns;
              return res[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
            } catch { return []; }
          },
        };
      }

      // DDL / other
      return {
        run(...vals) { db.run(sql); },
        get(...vals) { return null; },
        all(...vals) { return []; },
      };
    },

    exec(sql) {
      db.run(sql);
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
  const { initSchema } = await import("../src/core/db.js");
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
  `);
  return db;
}
