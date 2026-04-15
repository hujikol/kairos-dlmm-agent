/**
 * Debug script to test near_misses and lessons inserts in isolation.
 */
import Database from "better-sqlite3";
import { initSchema, closeDB } from "../src/core/db.js";
import crypto from "crypto";

const db = new Database(":memory:");
initSchema(db);

// Check what the actual schema is
console.log("=== near_misses columns ===");
const nmCols = db.prepare("PRAGMA table_info(near_misses)").all();
console.log(nmCols);

console.log("\n=== lessons columns ===");
const lCols = db.prepare("PRAGMA table_info(lessons)").all();
console.log(lCols);

// Test near_misses insert
console.log("\n=== Testing near_misses insert ===");
try {
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
  console.log("SUCCESS: near_misses insert worked");
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  console.log(e.stack);
}

// Test lessons insert
console.log("\n=== Testing lessons insert ===");
try {
  const lid = crypto.randomUUID();
  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, context, pnl_pct, range_efficiency, pool, created_at, pinned, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lid, "Test lesson rule", '["test"]', "bad", "test context", -10, 20,
    "pool_test", "2025-01-01T00:00:00Z", 0, null
  );
  console.log("SUCCESS: lessons insert worked");
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  console.log(e.stack);
}

closeDB(db);
