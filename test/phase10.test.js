/**
 * Phase 10: Learning System Improvement — Tests
 *
 * Run: node test/phase10.test.js
 *
 * Uses a temporary in-memory SQLite setup via the real db.js module.
 * Each test resets the DB state to avoid cross-test pollution.
 */

import { getDB, closeDB } from "../src/core/db.js";
import {
  recordPerformance,
  evolveThresholds,
  getLessonsForPrompt,
  getLearningStats,
  prunePerformance,
  pruneNearMisses,
  rateLesson,
  pinLesson,
  unpinLesson,
  listLessons,
  clearPerformance,
  clearAllLessons,
} from "../src/core/lessons.js";
import { ageWeight } from "../src/core/lessons.js";
import { analyzeClusters, detectAnomalies, generateInsights } from "../src/core/patterns.js";
import { getDB as getDBForPatterns } from "../src/core/db.js";

// ─── Test helpers ───────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, label) {
  if (condition) {
    passCount++;
    console.log(`  PASS: ${label}`);
  } else {
    failCount++;
    console.error(`  FAIL: ${label}`);
  }
}

function resetDB() {
  try {
    clearPerformance();
    clearAllLessons();
    const db = getDB();
    db.exec('DELETE FROM near_misses');
    db.exec('DELETE FROM performance_archive');
  } catch {}
}

// ─── Test 1: near_misses table created on startup ───────────

async function testNearMissTableExists() {
  console.log("\n--- Test 1: near_misses table exists ---");
  const db = getDB();
  const result = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='near_misses'"
  ).get();
  assert(result !== undefined, "near_misses table should exist");
}

// ─── Test 2: neutral outcomes are inserted into near_misses ───

async function testNeutralOutcomeRecorded() {
  console.log("\n--- Test 2: neutral outcomes recorded in near_misses ---");
  resetDB();
  const db = getDB();
  const before = db.prepare("SELECT COUNT(*) as c FROM near_misses").get().c;

  await recordPerformance({
    position: "testpos_neutral1",
    pool: "pool_neutral",
    pool_name: "TEST/NEUTRAL",
    strategy: "bid_ask",
    bin_range: [100, 120],
    bin_step: 90,
    volatility: 3.5,
    fee_tvl_ratio: 0.05,
    organic_score: 70,
    amount_sol: 0.5,
    fees_earned_usd: 0.1,
    final_value_usd: 250,   // very close to initial
    initial_value_usd: 251,
    minutes_in_range: 30,
    minutes_held: 40,
    close_reason: "manual",
    deployed_at: new Date().toISOString(),
    closed_at: new Date().toISOString(),
    base_mint: "So11111111111111111111111111111111111111112",
  });

  const after = db.prepare("SELECT COUNT(*) as c FROM near_misses").get().c;
  assert(after > before, `near_misses count should increase (${before} -> ${after})`);

  // Insert a second neutral to have more data for pattern tests
  await recordPerformance({
    position: "testpos_neutral2",
    pool: "pool_neutral",
    pool_name: "TEST/NEUTRAL2",
    strategy: "bid_ask",
    bin_range: [100, 120],
    bin_step: 95,
    volatility: 1.5,
    fee_tvl_ratio: 0.06,
    organic_score: 65,
    amount_sol: 0.5,
    fees_earned_usd: 0.2,
    final_value_usd: 248,
    initial_value_usd: 250,
    minutes_in_range: 20,
    minutes_held: 35,
    close_reason: "out_of_range",
    deployed_at: new Date().toISOString(),
    closed_at: new Date().toISOString(),
    base_mint: "So11111111111111111111111111111111111111112",
  });

  const after2 = db.prepare("SELECT COUNT(*) as c FROM near_misses").get().c;
  assert(after2 > after, `second neutral increases count (${after} -> ${after2})`);
}

// ─── Test 3: Pattern recognition produces output ────────────

async function testPatternRecognition() {
  console.log("\n--- Test 3: Pattern recognition produces output ---");

  // Create fake perf data for cluster analysis
  const fakePerf = [
    { strategy: "bid_ask", volatility: 1.5, bin_step: 85, pnl_pct: 5, range_efficiency: 70, minutes_held: 30 },
    { strategy: "bid_ask", volatility: 1.5, bin_step: 90, pnl_pct: 8, range_efficiency: 75, minutes_held: 25 },
    { strategy: "bid_ask", volatility: 1.5, bin_step: 95, pnl_pct: 3, range_efficiency: 60, minutes_held: 40 },
    { strategy: "bid_ask", volatility: 1.5, bin_step: 88, pnl_pct: -8, range_efficiency: 30, minutes_held: 15 },
    { strategy: "bid_ask", volatility: 1.5, bin_step: 92, pnl_pct: -12, range_efficiency: 20, minutes_held: 10 },
    { strategy: "spot", volatility: 7.5, bin_step: 120, pnl_pct: -5, range_efficiency: 15, minutes_held: 20 },
    { strategy: "spot", volatility: 7.5, bin_step: 115, pnl_pct: -10, range_efficiency: 10, minutes_held: 18 },
    { strategy: "spot", volatility: 7.5, bin_step: 118, pnl_pct: -15, range_efficiency: 5, minutes_held: 12 },
    { strategy: "spot", volatility: 7.5, bin_step: 110, pnl_pct: 2, range_efficiency: 50, minutes_held: 35 },
  ];

  const clusters = analyzeClusters(fakePerf);
  assert(clusters.length > 0, `analyzeClusters should return results (${clusters.length} clusters)`);

  const avoidClusters = clusters.filter(c => c.label === "avoid");
  const preferClusters = clusters.filter(c => c.label === "prefer");
  assert(avoidClusters.length > 0 || preferClusters.length > 0,
    `Should have avoid or prefer clusters (avoid: ${avoidClusters.length}, prefer: ${preferClusters.length})`);

  const anomalies = detectAnomalies(fakePerf);
  // With only 4 and 4 items per cluster, we may or may not get anomalies
  // Just verify it doesn't throw
  assert(Array.isArray(anomalies), "detectAnomalies should return an array");

  const fakeNearMisses = [
    { volatility: 1.5, bin_step: 105, pnl_pct: 1, range_efficiency: 35 },
    { volatility: 1.0, bin_step: 110, pnl_pct: 2, range_efficiency: 30 },
    { volatility: 1.2, bin_step: 108, pnl_pct: 0.5, range_efficiency: 25 },
  ];

  const insights = generateInsights(fakePerf, fakeNearMisses);
  assert(insights !== null && typeof insights === "string",
    `generateInsights should produce string output`);
  if (insights) {
    assert(insights.includes("PATTERN RECOGNITION") || insights.length > 20,
      "Insights should contain meaningful content");
  }
}

// ─── Test 4: Volatility evolution produces config changes ───

async function testVolatilityEvolution() {
  console.log("\n--- Test 4: Volatility evolution produces config changes ---");

  const fakeConfig = {
    screening: { maxBinStep: 125, minFeeActiveTvlRatio: 0.05, minOrganic: 60 },
  };

  // Create data where low volatility bucket has < 30% win rate
  // 3 winners, 8 losers = 3/11 = 27% win rate in "low" bucket
  const volatilePerformData = [
    // Low vol bucket (<3): poor performance
    { bin_step: 120, pnl_pct: -8, volatility: 1, minutes_held: 20, fee_tvl_ratio: 0.03, organic_score: 60 },
    { bin_step: 115, pnl_pct: -10, volatility: 1.5, minutes_held: 15, fee_tvl_ratio: 0.02, organic_score: 55 },
    { bin_step: 110, pnl_pct: -12, volatility: 2, minutes_held: 10, fee_tvl_ratio: 0.04, organic_score: 58 },
    { bin_step: 95, pnl_pct: -6, volatility: 2.5, minutes_held: 12, fee_tvl_ratio: 0.05, organic_score: 59 },
    { bin_step: 90, pnl_pct: -9, volatility: 1.2, minutes_held: 18, fee_tvl_ratio: 0.03, organic_score: 57 },
    { bin_step: 85, pnl_pct: -15, volatility: 0.8, minutes_held: 8, fee_tvl_ratio: 0.02, organic_score: 50 },
    { bin_step: 80, pnl_pct: -11, volatility: 1.8, minutes_held: 14, fee_tvl_ratio: 0.04, organic_score: 52 },
    { bin_step: 100, pnl_pct: -7, volatility: 2.2, minutes_held: 16, fee_tvl_ratio: 0.03, organic_score: 54 },
    // 3 winners in low vol
    { bin_step: 85, pnl_pct: 3, volatility: 1.0, minutes_held: 30, fee_tvl_ratio: 0.08, organic_score: 75 },
    { bin_step: 80, pnl_pct: 5, volatility: 1.5, minutes_held: 35, fee_tvl_ratio: 0.09, organic_score: 78 },
    { bin_step: 75, pnl_pct: 2, volatility: 2.0, minutes_held: 25, fee_tvl_ratio: 0.07, organic_score: 70 },
    // Some medium vol for comparison
    { bin_step: 90, pnl_pct: 1, volatility: 4, minutes_held: 30, fee_tvl_ratio: 0.05, organic_score: 65 },
    { bin_step: 85, pnl_pct: 2, volatility: 4.5, minutes_held: 35, fee_tvl_ratio: 0.06, organic_score: 68 },
    { bin_step: 100, pnl_pct: 3, volatility: 5, minutes_held: 40, fee_tvl_ratio: 0.07, organic_score: 72 },
  ];

  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const writeFileAtomic = await import("write-file-atomic");

  // Temporarily save a config file so evolveThresholds can write to it
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tempConfigPath = path.join(__dirname, "../src/user-config.test.json");

  // Mock config write path — evolveThresholds writes to user-config.json in its own dir
  // We need to test the actual evolution logic. Since we can't easily mock the config path,
  // let's test the core logic directly by setting up a real user-config.json in the test's src dir

  // Actually, let's test the config path directly:
  const USER_CONFIG_PATH = path.join(__dirname, "../src/user-config.json");
  let backup = null;
  try {
    if (fs.default.existsSync(USER_CONFIG_PATH)) {
      backup = fs.default.readFileSync(USER_CONFIG_PATH, "utf8");
    }
  } catch {}

  try {
    fs.default.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ maxPositions: 3, maxBinStep: 125 }));

    const { config } = await import("../src/config.js");
    const result = evolveThresholds(volatilePerformData, config);

    assert(result !== null, "evolveThresholds should return results");

    if (result && result.changes) {
      console.log(`    Changes: ${JSON.stringify(result.changes)}`);
      console.log(`    Rationale: ${JSON.stringify(result.rationale)}`);

      // The volatility evolution should have triggered maxBinStep reduction
      assert(result.changes.maxBinStep !== undefined || Object.keys(result.rationale).length > 0,
        "Should have changes or rationale from volatility bucket analysis");
    } else {
      assert(false, "no result returned");
    }
  } catch (e) {
    assert(false, `evolveThresholds threw: ${e.message}`);
  } finally {
    if (backup !== null) {
      fs.default.writeFileSync(USER_CONFIG_PATH, backup);
    }
  }
}

// ─── Test 5: Lesson decay weights are applied ───────────────

async function testLessonDecay() {
  console.log("\n--- Test 5: Lesson decay (age weights) ---");

  // ageWeight helper
  const now = new Date();

  const age1 = ageWeight(now.toISOString()); // 0 days
  assert(age1 === 1.0, `0 days => weight 1.0 (got ${age1})`);

  const age2 = ageWeight(new Date(now.getTime() - 3 * 86400000).toISOString()); // 3 days
  assert(age2 === 1.0, `3 days => weight 1.0 (got ${age2})`);

  const age3 = ageWeight(new Date(now.getTime() - 14 * 86400000).toISOString()); // 14 days
  assert(age3 === 0.7, `14 days => weight 0.7 (got ${age3})`);

  const age4 = ageWeight(new Date(now.getTime() - 60 * 86400000).toISOString()); // 60 days
  assert(age4 === 0.4, `60 days => weight 0.4 (got ${age4})`);

  const age5 = ageWeight(new Date(now.getTime() - 120 * 86400000).toISOString()); // 120 days
  assert(age5 === 0.2, `120 days => weight 0.2 (got ${age5})`);

  // Test with no date
  const age6 = ageWeight(null);
  assert(age6 === 0.2, `null date => weight 0.2 (got ${age6})`);

  // Test that getLessonsForPrompt doesn't crash
  resetDB();
  const output = getLessonsForPrompt({ agentType: "SCREENER", maxLessons: 5 });
  assert(output === null, `Empty DB should return null (${output})`);
}

// ─── Test 6: /teach commands (rate, pin, unpin, stats, list) ─

async function testTeachCommands() {
  console.log("\n--- Test 6: /teach commands (rate, pin, unpin, stats, list) ---");
  resetDB();

  // Create a test lesson manually via SQL
  const db = getDB();
  const { v4: uuidv4 } = await import("crypto");
  const testId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, context, pnl_pct, range_efficiency, pool, created_at, pinned, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testId, "Test lesson rule", '["test"]', "bad", "test context", -10, 20,
    "pool_test", "2025-01-01T00:00:00Z", 0, null
  );

  // Test pin
  const pinResult = pinLesson(testId);
  assert(pinResult.found === true && pinResult.pinned === true, "pinLesson should succeed");

  // Verify pinned in listLessons
  const lessons = listLessons({ pinned: true });
  assert(lessons.lessons.some(l => l.id === testId), "Pinned lesson should appear in pinned list");

  // Test unpin
  const unpinResult = unpinLesson(testId);
  assert(unpinResult.found === true && unpinResult.pinned === false, "unpinLesson should succeed");

  // Test rate useful
  const rateResult = rateLesson(testId, "useful");
  assert(rateResult.found === true && rateResult.rating === "useful", "rateLesson 'useful' should succeed");

  // Test rate useless
  const rateResult2 = rateLesson(testId, "useless");
  assert(rateResult2.found === true && rateResult2.rating === "useless", "rateLesson 'useless' should succeed");

  // Test invalid rating
  const rateResult3 = rateLesson(testId, "invalid");
  assert(rateResult3.error !== undefined, "Invalid rating should return error");

  // Test getLearningStats
  const stats = getLearningStats();
  assert(stats.total_lessons === 1, `Stats should show 1 lesson (got ${stats.total_lessons})`);
  assert(stats.rated_useful === 0, `Rated useful should be 0 after overwrite`); // overwritten to useless
  assert(stats.rated_useless === 1, `Rated useless should be 1`);

  // Test list
  const listResult = listLessons({ limit: 5 });
  assert(listResult.total >= 1, "List should return at least 1 lesson");
}

// ─── Test 7: Pruning doesn't error on empty tables ──────────

async function testPruningEmptyTables() {
  console.log("\n--- Test 7: Pruning on empty tables ---");
  resetDB();

  // Prune on empty tables should not throw
  try {
    const perfResult = prunePerformance();
    assert(true, "prunePerformance didn't throw on empty table");
    assert(perfResult.archived === 0, "Should archive 0 records");
  } catch (e) {
    assert(false, `prunePerformance threw: ${e.message}`);
  }

  try {
    const nmResult = pruneNearMisses();
    assert(true, "pruneNearMisses didn't throw on empty table");
    assert(nmResult.pruned === 0, "Should prune 0 records");
  } catch (e) {
    assert(false, `pruneNearMisses threw: ${e.message}`);
  }
}

// ─── Test 8: Performance auto-archiving ─────────────────────

async function testPerformanceArchiving() {
  console.log("\n--- Test 8: Performance auto-archiving ---");
  resetDB();
  const db = getDB();

  // Insert 150 records (below 200 threshold)
  for (let i = 0; i < 150; i++) {
    db.prepare(`
      INSERT INTO performance (position, pool, pool_name, strategy, bin_range, bin_step, volatility,
        fee_tvl_ratio, organic_score, amount_sol, fees_earned_usd, final_value_usd,
        initial_value_usd, minutes_in_range, minutes_held, close_reason, pnl_usd,
        pnl_pct, range_efficiency, deployed_at, closed_at, recorded_at, base_mint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `pos_arch_${i}`, "pool_arch", `ARCH/SOL`, "bid_ask", "[100,120]",
      90 + (i % 20), 2 + (i % 4) * 0.5, 0.05 + i * 0.001, 60 + i % 10,
      0.5, 0.2, 255 + i, 250,
      30 + i % 10, 40 + i % 20, "manual",
      (i - 75), (i - 75) * 0.1, 50 + i % 30,
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
      "So11111111111111111111111111111111111111112"
    );
  }
  const count150 = db.prepare('SELECT COUNT(*) as c FROM performance').get().c;
  assert(count150 === 150, `Should have 150 records (got ${count150})`);

  const result1 = prunePerformance();
  assert(result1.archived === 0, `Should not prune below 200 threshold (got ${result1.archived})`);

  // Insert 60 more to go over threshold (total 210)
  for (let i = 150; i < 210; i++) {
    db.prepare(`
      INSERT INTO performance (position, pool, pool_name, strategy, bin_range, bin_step, volatility,
        fee_tvl_ratio, organic_score, amount_sol, fees_earned_usd, final_value_usd,
        initial_value_usd, minutes_in_range, minutes_held, close_reason, pnl_usd,
        pnl_pct, range_efficiency, deployed_at, closed_at, recorded_at, base_mint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `pos_arch2_${i}`, "pool_arch", `ARCH/SOL`, "bid_ask", "[100,120]",
      90 + (i % 20), 2 + (i % 4) * 0.5, 0.05 + i * 0.001, 60 + i % 10,
      0.5, 0.2, 255 + i, 250,
      30 + i % 10, 40 + i % 20, "manual",
      (i - 105), (i - 105) * 0.1, 50 + i % 30,
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
      "So111111111111111111111111111111112"
    );
  }

  const count210 = db.prepare('SELECT COUNT(*) as c FROM performance').get().c;
  assert(count210 === 210, `Should have 210 records (got ${count210})`);

  const result2 = prunePerformance();
  assert(result2.archived === 110, `Should archive 110 records (210 - 100 = 110, got ${result2.archived})`);

  const archived = db.prepare('SELECT COUNT(*) as c FROM performance_archive').get().c;
  assert(archived === 110, `Archive should have 110 records (got ${archived})`);

  const remaining = db.prepare('SELECT COUNT(*) as c FROM performance').get().c;
  assert(remaining === 100, `Should have exactly 100 remaining (got ${remaining})`);
}

// ─── Test 9: Near-miss pruning ──────────────────────────────

async function testNearMissPruning() {
  console.log("\n--- Test 9: Near-miss pruning ---");
  resetDB();
  const db = getDB();

  // Insert old records (100 days ago)
  for (let i = 0; i < 5; i++) {
    const oldDate = new Date(Date.now() - 100 * 86400000 + i * 1000).toISOString();
    db.prepare(`
      INSERT INTO near_misses (id, position, pool, strategy, bin_step, volatility,
        fee_tvl_ratio, organic_score, pnl_usd, pnl_pct, minutes_in_range,
        minutes_held, range_efficiency, close_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `old_nm_${i}`, `old_pos_${i}`, "old_pool", "bid_ask",
      90 + i, 2.0 + i * 0.1, 0.05, 60, 1.0, 1.0,
      30, 40, 75, "manual", oldDate
    );
  }

  // Insert recent records
  for (let i = 0; i < 3; i++) {
    const recentDate = new Date(Date.now() - i * 1000).toISOString();
    db.prepare(`
      INSERT INTO near_misses (id, position, pool, strategy, bin_step, volatility,
        fee_tvl_ratio, organic_score, pnl_usd, pnl_pct, minutes_in_range,
        minutes_held, range_efficiency, close_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `recent_nm_${i}`, `recent_pos_${i}`, "recent_pool", "bid_ask",
      90 + i, 2.0 + i * 0.1, 0.05, 60, 1.0, 1.0,
      30, 40, 75, "manual", recentDate
    );
  }

  const beforePrune = db.prepare('SELECT COUNT(*) as c FROM near_misses').get().c;
  assert(beforePrune === 8, `Should have 8 near_misses (got ${beforePrune})`);

  const result = pruneNearMisses();
  assert(result.pruned === 5, `Should prune 5 old records (got ${result.pruned})`);

  const afterPrune = db.prepare('SELECT COUNT(*) as c FROM near_misses').get().c;
  assert(afterPrune === 3, `Should have 3 remaining (got ${afterPrune})`);
}

// ─── Run all tests ──────────────────────────────────────────

async function main() {
  console.log("=== Phase 10: Learning System Improvement Tests ===");

  try {
    await testNearMissTableExists();
    await testNeutralOutcomeRecorded();
    await testPatternRecognition();
    await testVolatilityEvolution();
    await testLessonDecay();
    await testTeachCommands();
    await testPruningEmptyTables();
    await testPerformanceArchiving();
    await testNearMissPruning();
  } catch (e) {
    console.error(`\n!!! Test suite error: ${e.message}`);
    console.error(e.stack);
  }

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
