/**
 * Tests for FEATURE-BINLEARN-01 bin learning system.
 * Verifies: getBinSuggestion(), getBinStatsByVolatility(), recordPoolDeploy().
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import initSqlJs from "sql.js";

// Inject in-memory DB before importing pool-memory
const { _injectDB } = await import("../src/core/db.js");
const { _resetPositionsCache } = await import("../src/integrations/meteora/positions.js");

// ─── In-memory DB with pool-memory schema ─────────────────────────

async function makePoolMemoryDB() {
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
          run(..._vals) {
            // Use bound args (from .bind()) or positional args passed to run()
            const args = this._runArgs || _vals;
            db.run(sql, args.length > 0 ? args : undefined);
          },
          get() { return null; },
          free() {},
          reset() {},
          getRowsModified: () => db._db.getRowsModified(),
        };
        return stmt;
      }

      if (upper.startsWith("SELECT")) {
        const rawStmt = db.prepare(sql);
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        const _tableName = tableMatch ? tableMatch[1] : null;

        return {
          bind(...vals) { rawStmt.bind(vals); return this; },
          step() { return rawStmt.step(); },
          get() { return rawStmt.step() ? rawStmt.getAsObject() : null; },
          free() { rawStmt.free(); },
          reset() { rawStmt.reset(); },
          getAsObject() { return rawStmt.getAsObject(); },
          _raw: rawStmt,
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

    exec(sql) { db.run(sql); },
    run(sql, ...vals) { db.run(sql, ...vals); },
    close() {},
    export() { return db.export(); },
    _db: db,
  };

  // Create pool-memory schema (migrate() will run fresh on empty _schema_versions)
  db.run(`
    CREATE TABLE IF NOT EXISTS pool_memory (
      pool_address TEXT PRIMARY KEY,
      name TEXT,
      base_mint TEXT,
      total_deploys INTEGER DEFAULT 0,
      avg_pnl_pct REAL DEFAULT 0,
      win_rate REAL DEFAULT 0,
      last_deployed_at TEXT,
      last_outcome TEXT,
      notes TEXT DEFAULT '[]',
      cooldown_until TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pool_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      deployed_at TEXT,
      closed_at TEXT,
      pnl_pct REAL,
      pnl_usd REAL,
      range_efficiency REAL,
      minutes_held INTEGER,
      close_reason TEXT,
      strategy TEXT,
      volatility_at_deploy REAL,
      lower_bin INTEGER,
      upper_bin INTEGER,
      total_bins INTEGER
    )
  `);
  // Seed schema versions so migrate() skips all migrations
  db.run(`
    CREATE TABLE IF NOT EXISTS _schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT)
  `);
  db.run(`INSERT INTO _schema_versions VALUES (1, '2026-01-01T00:00:00.000Z')`);
  db.run(`INSERT INTO _schema_versions VALUES (2, '2026-01-01T00:00:00.000Z')`);
  db.run(`INSERT INTO _schema_versions VALUES (3, '2026-01-01T00:00:00.000Z')`);
  db.run(`INSERT INTO _schema_versions VALUES (4, '2026-01-01T00:00:00.000Z')`);
  db.run(`INSERT INTO _schema_versions VALUES (5, '2026-01-01T00:00:00.000Z')`);

  return wrapper;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("FEATURE-BINLEARN-01 bin learning", () => {
  let db;

  beforeEach(async () => {
    db = await makePoolMemoryDB();
    _injectDB(db);
    _resetPositionsCache();
  });

  describe("getBinSuggestion()", () => {
    it("returns null for pools with fewer than 2 winning deploys", async () => {
      const { getBinSuggestion } = await import("../src/features/pool-memory.js");

      // Insert a pool with only 1 winning deploy
      db.prepare(`
        INSERT INTO pool_memory (pool_address, name) VALUES ('Pool1', 'Pool1')
      `).run();
      db.prepare(`
        INSERT INTO pool_deploys (pool_address, pnl_pct, lower_bin, upper_bin, total_bins)
        VALUES ('Pool1', 10.0, 100, 130, 30)
      `).run();

      const result = getBinSuggestion("Pool1");
      assert.strictEqual(result, null);
    });

    it("returns null for pools with no winning deploys (pnl_pct < 5)", async () => {
      const { getBinSuggestion } = await import("../src/features/pool-memory.js");

      db.prepare(`
        INSERT INTO pool_memory (pool_address, name) VALUES ('Pool2', 'Pool2')
      `).run();
      // All deploys are losers (pnl_pct < 5)
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO pool_deploys (pool_address, pnl_pct, lower_bin, upper_bin, total_bins)
          VALUES ('Pool2', -3.0, 100, 130, 30)
        `).run();
      }

      const result = getBinSuggestion("Pool2");
      assert.strictEqual(result, null);
    });

    it("returns null for pools with no bin data even with 3+ winning deploys", async () => {
      const { getBinSuggestion } = await import("../src/features/pool-memory.js");

      db.prepare(`
        INSERT INTO pool_memory (pool_address, name) VALUES ('Pool3', 'Pool3')
      `).run();
      // 3 winners but no bin data
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO pool_deploys (pool_address, pnl_pct, lower_bin, upper_bin, total_bins)
          VALUES ('Pool3', 10.0, NULL, NULL, NULL)
        `).run();
      }

      const result = getBinSuggestion("Pool3");
      assert.strictEqual(result, null);
    });

    it("returns median bin config for pools with 3+ winning deploys", async () => {
      const { getBinSuggestion } = await import("../src/features/pool-memory.js");

      db.prepare(`
        INSERT INTO pool_memory (pool_address, name) VALUES ('Pool4', 'Pool4')
      `).run();
      // Insert 5 winning deploys with known bin values
      // lower bins: 95, 100, 102, 105, 110 → median = 102
      // upper bins: 125, 130, 135, 138, 140 → median = 135
      // total bins: 28, 30, 32, 34, 38 → median = 32
      const winners = [
        { lb: 95, ub: 125, tb: 28 },
        { lb: 100, ub: 130, tb: 30 },
        { lb: 102, ub: 135, tb: 32 },
        { lb: 105, ub: 138, tb: 34 },
        { lb: 110, ub: 140, tb: 38 },
      ];
      for (const w of winners) {
        db.prepare(`
          INSERT INTO pool_deploys (pool_address, pnl_pct, lower_bin, upper_bin, total_bins)
          VALUES ('Pool4', 10.0, ${w.lb}, ${w.ub}, ${w.tb})
        `).run();
      }

      const result = getBinSuggestion("Pool4");
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.lower_bin, 102);
      assert.strictEqual(result.upper_bin, 135);
      assert.strictEqual(result.total_bins, 32);
      assert.strictEqual(result.sample_size, 5);
    });

    it("returns null for unknown pools", async () => {
      const { getBinSuggestion } = await import("../src/features/pool-memory.js");

      const result = getBinSuggestion("UnknownPoolXYZ");
      assert.strictEqual(result, null);
    });
  });

  describe("getBinStatsByVolatility()", () => {
    it("groups by volatility bucket correctly (0.5 increments)", async () => {
      const { getBinStatsByVolatility } = await import("../src/features/pool-memory.js");

      db.prepare(`
        INSERT INTO pool_memory (pool_address, name) VALUES ('PoolV1', 'PoolV1')
      `).run();

      // Insert deploys with volatility_at_deploy values
      // Vol 1.0 → bucket 1.0, Vol 1.4 → bucket 1.5, Vol 1.7 → bucket 1.5
      const deploys = [
        { vol: 1.0, lb: 90, ub: 120, tb: 28, pnl: 8.0 },
        { vol: 1.4, lb: 95, ub: 125, tb: 30, pnl: 12.0 },
        { vol: 1.7, lb: 98, ub: 128, tb: 32, pnl: -2.0 },
      ];
      for (const d of deploys) {
        db.prepare(`
          INSERT INTO pool_deploys (pool_address, volatility_at_deploy, lower_bin, upper_bin, total_bins, pnl_pct)
          VALUES ('PoolV1', ${d.vol}, ${d.lb}, ${d.ub}, ${d.tb}, ${d.pnl})
        `).run();
      }

      const result = getBinStatsByVolatility(1.5);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.avg_lower_bin, 96); // avg of 95 and 98 = 96.5 → rounds to 96
      assert.strictEqual(result.avg_upper_bin, 126); // avg of 125 and 128 = 126.5 → rounds to 126
      assert.strictEqual(result.avg_total_bins, 31); // avg of 30 and 32 = 31
      assert.strictEqual(result.sample_size, 2);
      assert.strictEqual(result.win_rate_at_vol, 50); // 1 winner out of 2 → 50%
    });

    it("returns null for volatility with no historical data", async () => {
      const { getBinStatsByVolatility } = await import("../src/features/pool-memory.js");

      const result = getBinStatsByVolatility(5.0);
      assert.strictEqual(result, null);
    });

    it("returns null when volatility arg is null", async () => {
      const { getBinStatsByVolatility } = await import("../src/features/pool-memory.js");

      const result = getBinStatsByVolatility(null);
      assert.strictEqual(result, null);
    });
  });

  describe("recordPoolDeploy() with binConfig", () => {
    it("stores bin config in pool_deploys", async () => {
      const { recordPoolDeploy } = await import("../src/features/pool-memory.js");

      recordPoolDeploy("BinPool1", {
        pool_name: "BinPool1",
        pnl_pct: 7.5,
        deployed_at: "2025-01-01T00:00:00Z",
        closed_at: "2025-01-02T00:00:00Z",
        strategy: "bid_ask",
        volatility: 2.1,
      }, { lower_bin: 85, upper_bin: 115, total_bins: 30 });

      const row = db.prepare(`
        SELECT lower_bin, upper_bin, total_bins FROM pool_deploys WHERE pool_address = 'BinPool1'
      `).get();

      assert.strictEqual(row.lower_bin, 85);
      assert.strictEqual(row.upper_bin, 115);
      assert.strictEqual(row.total_bins, 30);
    });

    it("handles null binConfig gracefully", async () => {
      const { recordPoolDeploy } = await import("../src/features/pool-memory.js");

      recordPoolDeploy("BinPool2", {
        pool_name: "BinPool2",
        pnl_pct: 3.0,
        deployed_at: "2025-01-01T00:00:00Z",
        closed_at: "2025-01-02T00:00:00Z",
        strategy: "bid_ask",
      }, null);

      const row = db.prepare(`
        SELECT lower_bin, upper_bin, total_bins FROM pool_deploys WHERE pool_address = 'BinPool2'
      `).get();

      assert.strictEqual(row.lower_bin, null);
      assert.strictEqual(row.upper_bin, null);
      assert.strictEqual(row.total_bins, null);
    });

    it("updates pool_memory aggregates after deploy", async () => {
      const { recordPoolDeploy } = await import("../src/features/pool-memory.js");

      recordPoolDeploy("AggPool1", {
        pool_name: "AggPool1",
        pnl_pct: 10.0,
        deployed_at: "2025-01-01T00:00:00Z",
        closed_at: "2025-01-02T00:00:00Z",
        strategy: "bid_ask",
        volatility: 1.5,
      }, { lower_bin: 90, upper_bin: 120, total_bins: 30 });

      const mem = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get("AggPool1");
      assert.strictEqual(mem.total_deploys, 1);
      assert.strictEqual(mem.avg_pnl_pct, 10.0);
      assert.strictEqual(mem.win_rate, 1.0);
    });
  });
});