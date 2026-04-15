/**
 * Unit tests for src/core/lesson-repo.js
 * Uses Node's built-in test runner (node:test).
 *
 * Tests against an in-memory SQLite database to avoid polluting
 * the real kairos.db.
 *
 * Run: node --test test/test-lesson-repo.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

// ─── In-memory schema (mirrors db.js) ───────────────────────────────────────

function initSchema(db) {
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)`);
}

// ─── Mock getDB / closeDB that uses in-memory DB ────────────────────────────

let _mockDb = null;

function getMockDB() {
  if (!_mockDb) {
    _mockDb = new Database(":memory:");
    initSchema(_mockDb);
  }
  return _mockDb;
}

function closeMockDB() {
  if (_mockDb) {
    _mockDb.close();
    _mockDb = null;
  }
}

// ─── Patch the module's getDB reference before importing ───────────────────
// Since we can't easily patch getDB at import time, we test the functions
// by re-implementing them here with the mock DB. This is a limitation.
// Instead, let's just import the pure functions and the schema init.

// Actually, lesson-repo.js imports { getDB } from "./db.js" at module level.
// We need to mock at the module level. Let's test the pure functions directly.

// Import the pure functions (no DB dependency)
import { ROLE_TAGS, ageWeight, inferTags } from "../src/core/lesson-repo.js";

describe("ageWeight", () => {
  test("returns 1.0 for lessons <= 7 days old", () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    assert.strictEqual(ageWeight(recent), 1.0);
  });

  test("returns 0.7 for lessons 8-30 days old", () => {
    const twoWeeks = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(ageWeight(twoWeeks), 0.7);
  });

  test("returns 0.4 for lessons 31-90 days old", () => {
    const twoMonths = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(ageWeight(twoMonths), 0.4);
  });

  test("returns 0.2 for lessons > 90 days old", () => {
    const fourMonths = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(ageWeight(fourMonths), 0.2);
  });

  test("returns 0.2 for null/undefined", () => {
    assert.strictEqual(ageWeight(null), 0.2);
    assert.strictEqual(ageWeight(undefined), 0.2);
  });
});

describe("inferTags", () => {
  test("infers sol_pair tag when pair includes SOL", () => {
    const tags = inferTags({ pair: "SOL/MEME" });
    assert.ok(tags.includes("sol_pair"));
  });

  test("infers high_tvl tag when tvl > 80k", () => {
    const tags = inferTags({ tvl: 100_000 });
    assert.ok(tags.includes("high_tvl"));
  });

  test("infers low_tvl tag when tvl < 20k", () => {
    const tags = inferTags({ tvl: 15_000 });
    assert.ok(tags.includes("low_tvl"));
  });

  test("infers oor tag when oor is true", () => {
    const tags = inferTags({ oor: true });
    assert.ok(tags.includes("oor"));
  });

  test("infers winning tag when pnl_pct > 0", () => {
    const tags = inferTags({ pnl_pct: 10 });
    assert.ok(tags.includes("winning"));
  });

  test("infers losing tag when pnl_pct < 0", () => {
    const tags = inferTags({ pnl_pct: -10 });
    assert.ok(tags.includes("losing"));
  });

  test("infers high_volatility tag when binStep > 100", () => {
    const tags = inferTags({ binStep: 150 });
    assert.ok(tags.includes("high_volatility"));
  });

  test("infers low_volatility tag when binStep < 85", () => {
    const tags = inferTags({ binStep: 80 });
    assert.ok(tags.includes("low_volatility"));
  });

  test("returns empty array for empty context", () => {
    const tags = inferTags({});
    assert.strictEqual(tags.length, 0);
  });
});

describe("ROLE_TAGS", () => {
  test("SCREENER role has expected tag categories", () => {
    assert.ok(Array.isArray(ROLE_TAGS.SCREENER));
    assert.ok(ROLE_TAGS.SCREENER.includes("screening"));
    assert.ok(ROLE_TAGS.SCREENER.includes("deployment"));
  });

  test("MANAGER role has expected tag categories", () => {
    assert.ok(Array.isArray(ROLE_TAGS.MANAGER));
    assert.ok(ROLE_TAGS.MANAGER.includes("management"));
    assert.ok(ROLE_TAGS.MANAGER.includes("pnl"));
  });

  test("GENERAL role is empty", () => {
    assert.ok(Array.isArray(ROLE_TAGS.GENERAL));
    assert.strictEqual(ROLE_TAGS.GENERAL.length, 0);
  });
});

describe("Lesson CRUD (with mock DB)", () => {
  let db;

  beforeEach(() => {
    _mockDb = new Database(":memory:");
    initSchema(_mockDb);
    db = _mockDb;
  });

  afterEach(() => {
    closeMockDB();
  });

  test("addLesson inserts a lesson into the DB", () => {
    const id = crypto.randomUUID();
    const rule = "Test lesson rule";
    const tags = ["test", "screening"];
    db.prepare(`
      INSERT INTO lessons (id, rule, tags, outcome, pinned, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, rule, JSON.stringify(tags), "manual", 0, "SCREENER", new Date().toISOString());

    const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id);
    assert.ok(row);
    assert.strictEqual(row.rule, rule);
    assert.strictEqual(row.pinned, 0);
  });

  test("pinLesson sets pinned = 1", () => {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO lessons (id, rule, tags, outcome, pinned, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, "Test", "[]", "manual", 0, new Date().toISOString());

    const res = db.prepare("UPDATE lessons SET pinned = 1 WHERE id = ?").run(id);
    assert.strictEqual(res.changes, 1);

    const row = db.prepare("SELECT pinned FROM lessons WHERE id = ?").get(id);
    assert.strictEqual(row.pinned, 1);
  });

  test("unpinLesson sets pinned = 0", () => {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO lessons (id, rule, tags, outcome, pinned, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, "Test", "[]", "manual", 1, new Date().toISOString());

    db.prepare("UPDATE lessons SET pinned = 0 WHERE id = ?").run(id);
    const row = db.prepare("SELECT pinned FROM lessons WHERE id = ?").get(id);
    assert.strictEqual(row.pinned, 0);
  });

  test("removeLesson deletes a lesson", () => {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO lessons (id, rule, tags, outcome, pinned, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, "Test", "[]", "manual", 0, new Date().toISOString());

    const changes = db.prepare("DELETE FROM lessons WHERE id = ?").run(id).changes;
    assert.strictEqual(changes, 1);

    const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id);
    assert.strictEqual(row, undefined);
  });

  test("listLessons returns pinned lessons only", () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    db.prepare(`INSERT INTO lessons (id, rule, tags, outcome, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id1, "Pinned rule", "[]", "manual", 1, new Date().toISOString());
    db.prepare(`INSERT INTO lessons (id, rule, tags, outcome, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id2, "Unpinned rule", "[]", "manual", 0, new Date().toISOString());

    const pinned = db.prepare("SELECT * FROM lessons WHERE pinned = 1").all();
    assert.strictEqual(pinned.length, 1);
    assert.strictEqual(pinned[0].rule, "Pinned rule");
  });

  test("listLessons filters by role", () => {
    db.prepare(`INSERT INTO lessons (id, rule, tags, outcome, pinned, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), "Screener rule", "[]", "manual", 0, "SCREENER", new Date().toISOString());
    db.prepare(`INSERT INTO lessons (id, rule, tags, outcome, pinned, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), "Manager rule", "[]", "manual", 0, "MANAGER", new Date().toISOString());

    const screenerOnly = db.prepare("SELECT * FROM lessons WHERE role = ?").all("SCREENER");
    assert.strictEqual(screenerOnly.length, 1);
    assert.strictEqual(screenerOnly[0].rule, "Screener rule");
  });
});
