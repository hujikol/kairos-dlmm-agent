/**
 * Integration test for near_misses and lessons inserts against an
 * in-memory better-sqlite3 DB with full schema (migrate + initSchema).
 * Run with: node --test test/debug_insert.js
 */
import Database from "better-sqlite3";
import { initSchema, migrate, _injectDB } from "../src/core/db.js";
import { test } from "node:test";
import assert from "node:assert";
import crypto from "crypto";

const db = new Database(":memory:");
// _injectDB sets the module-level _db so migrate()'s internal _all() call works
_injectDB(db);
migrate(db);
initSchema(db);

// Check what the actual schema is
const nmCols = db.prepare("PRAGMA table_info(near_misses)").all();
assert.ok(nmCols.length > 0, "near_misses table should exist");

const lCols = db.prepare("PRAGMA table_info(lessons)").all();
assert.ok(lCols.length > 0, "lessons table should exist");

// Test near_misses insert
test("near_misses insert works with full schema", () => {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO near_misses (
      id, position, pool, strategy, bin_step, volatility,
      fee_tvl_ratio, organic_score, pnl_usd, pnl_pct,
      minutes_in_range, minutes_held, range_efficiency,
      close_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, "testpos", "pool_test", "bid_ask", 90,
    3.5, 0.05, 70,
    0.5, 1.5, 30, 40, 75,
    "manual", new Date().toISOString()
  );
  const row = db.prepare("SELECT * FROM near_misses WHERE id = ?").get(id);
  assert.strictEqual(row.pool, "pool_test");
  assert.strictEqual(row.strategy, "bid_ask");
  assert.strictEqual(row.bin_step, 90);
});

// Test lessons insert
test("lessons insert works with full schema", () => {
  const lid = crypto.randomUUID();
  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, context, pnl_pct, range_efficiency, pool, created_at, pinned, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lid, "Test lesson rule", '["test"]', "bad", "test context", -10, 20,
    "pool_test", "2025-01-01T00:00:00Z", 0, null
  );
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(lid);
  assert.strictEqual(row.rule, "Test lesson rule");
  assert.strictEqual(row.outcome, "bad");
  assert.strictEqual(row.pnl_pct, -10);
});
