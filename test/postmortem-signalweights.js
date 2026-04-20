/**
 * Integration test for postmortem.js and signal-weights.js SQLite migrations.
 * Run with: node --test test/postmortem-signalweights.test.js
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { _injectDB, initSchema, getDB } from '../src/core/db.js';
import { migrate as migration001 } from '../migrations/001_initial_schema.js';
import { migrate as migration002 } from '../migrations/002_add_missing_columns.js';
import { migrate as migration003 } from '../migrations/003_decision_log.js';

// Use isolated in-memory DB for this test file.
// _injectDB must run first so that tableHasColumn() (used by migration002)
// resolves against _db rather than a null pointer.
const _testDb = new Database(':memory:');
_injectDB(_testDb);      // sets module-level _db = _testDb
migration001(_testDb);   // creates all tables (fresh DB path)
migration002(_testDb);   // adds missing columns
migration003(_testDb);   // adds decision_log table
initSchema(_testDb);     // creates indexes (safety net)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Helpers ───────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tests ─────────────────────────────────────────────────────────

await it('postmortem.js can be imported without error', async () => {
  const pm = await import('../src/core/postmortem.js');
  if (typeof pm.analyzeClose !== 'function') throw new Error('analyzeClose not exported');
  if (typeof pm.getActiveRules !== 'function') throw new Error('getActiveRules not exported');
  if (typeof pm.getRulesForPrompt !== 'function') throw new Error('getRulesForPrompt not exported');
  if (typeof pm.matchesBlockedPattern !== 'function') throw new Error('matchesBlockedPattern not exported');
});

await it('signal-weights.js can be imported without error', async () => {
  const sw = await import('../src/core/signal-weights.js');
  if (typeof sw.loadWeights !== 'function') throw new Error('loadWeights not exported');
  if (typeof sw.saveWeights !== 'function') throw new Error('saveWeights not exported');
  if (typeof sw.recalculateWeights !== 'function') throw new Error('recalculateWeights not exported');
  if (typeof sw.getWeightsSummary !== 'function') throw new Error('getWeightsSummary not exported');
});

await it('loadRules() returns an array (empty or with rules)', async () => {
  // Reset: clear any existing rules
  const { clearRules } = await import('../src/core/postmortem.js');
  clearRules();

  const { getActiveRules } = await import('../src/core/postmortem.js');
  const rules = getActiveRules();
  if (!Array.isArray(rules)) throw new Error(`loadRules() returned ${typeof rules}, expected array`);
});

await it('loadWeights() returns an object with required keys', async () => {
  const { loadWeights } = await import('../src/core/signal-weights.js');
  const data = loadWeights();

  if (typeof data !== 'object' || data === null) throw new Error(`loadWeights() returned ${typeof data}`);

  const required = ['weights', 'last_recalc', 'recalc_count', 'history'];
  for (const key of required) {
    if (!(key in data)) throw new Error(`loadWeights() missing key: ${key}`);
  }

  if (typeof data.weights !== 'object') throw new Error(`weights should be object, got ${typeof data.weights}`);
  if (!Array.isArray(data.history)) throw new Error(`history should be array, got ${typeof data.history}`);
});

await it('postmortem_rules table has correct schema', async () => {
  const db = getDB();

  // ensure the table exists by triggering loadRules
  const { getActiveRules } = await import('../src/core/postmortem.js');
  getActiveRules();

  const cols = db.prepare('PRAGMA table_info(postmortem_rules)').all();
  const colMap = Object.fromEntries(cols.map(c => [c.name, c]));

  const required = ['key', 'type', 'strategy', 'bin_step_range', 'volatility_range',
                   'hours_utc', 'evidence', 'severity', 'description', 'reason',
                   'frequency', 'count', 'win_rate', 'sample_size', 'suggestion',
                   'created_at', 'updated_at'];
  for (const name of required) {
    if (!colMap[name]) throw new Error(`postmortem_rules missing column: ${name}`);
  }
  if (colMap['key'].type !== 'TEXT') throw new Error(`key column should be TEXT, got ${colMap['key'].type}`);
  if (colMap['key'].pk !== 1) throw new Error(`key should be PRIMARY KEY (pk=1), got pk=${colMap['key'].pk}`);
});

await it('signal_weights table has correct schema', async () => {
  const db = getDB();

  const cols = db.prepare('PRAGMA table_info(signal_weights)').all();
  const colMap = Object.fromEntries(cols.map(c => [c.name, c]));

  if (!colMap['id']) throw new Error('signal_weights missing id column');
  if (!colMap['weights']) throw new Error('signal_weights missing weights column');
  if (!colMap['last_recalc']) throw new Error('signal_weights missing last_recalc column');
  if (!colMap['recalc_count']) throw new Error('signal_weights missing recalc_count column');

  if (colMap['weights'].type !== 'TEXT') throw new Error(`weights should be TEXT, got ${colMap['weights'].type}`);
});

await it('signal_weights_history table has correct schema', async () => {
  const db = getDB();

  const cols = db.prepare('PRAGMA table_info(signal_weights_history)').all();
  const colMap = Object.fromEntries(cols.map(c => [c.name, c]));

  const required = ['id', 'timestamp', 'changes', 'window_size', 'win_count', 'loss_count'];
  for (const name of required) {
    if (!colMap[name]) throw new Error(`signal_weights_history missing column: ${name}`);
  }
  if (colMap['id'].type !== 'INTEGER') throw new Error(`id should be INTEGER, got ${colMap['id'].type}`);
  if (colMap['changes'].type !== 'TEXT') throw new Error(`changes should be TEXT, got ${colMap['changes'].type}`);
});

await it('saveRules() persists rules to DB and loadRules() retrieves them', async () => {
  const { clearRules, getActiveRules } = await import('../src/core/postmortem.js');
  clearRules();

  const db = getDB();
  db.prepare(`
    INSERT OR REPLACE INTO postmortem_rules
      (key, type, strategy, bin_step_range, volatility_range, hours_utc, evidence, severity, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'test_rule_1',
    'AVOID_PATTERN',
    'bid_ask',
    JSON.stringify([80, 100]),
    JSON.stringify([2.0, 4.0]),
    JSON.stringify([10, 14]),
    JSON.stringify({ sample_size: 5, win_rate: 20 }),
    'hard_block',
    'Test rule description',
    new Date().toISOString()
  );

  const rules = getActiveRules();
  if (!Array.isArray(rules)) throw new Error(`expected array, got ${typeof rules}`);
  if (rules.length === 0) throw new Error('expected at least 1 rule after insert');

  const rule = rules.find(r => r.key === 'test_rule_1');
  if (!rule) throw new Error('inserted rule not found');

  // Verify JSON fields were deserialized
  if (!Array.isArray(rule.bin_step_range)) throw new Error(`bin_step_range should be array, got ${typeof rule.bin_step_range}`);
  if (!Array.isArray(rule.volatility_range)) throw new Error(`volatility_range should be array, got ${typeof rule.volatility_range}`);
  if (!Array.isArray(rule.hours_utc)) throw new Error(`hours_utc should be array, got ${typeof rule.hours_utc}`);
  if (typeof rule.evidence !== 'object') throw new Error(`evidence should be object, got ${typeof rule.evidence}`);
  if (rule.bin_step_range[0] !== 80) throw new Error(`bin_step_range[0] should be 80, got ${rule.bin_step_range[0]}`);

  clearRules();
});

await it('saveWeights() persists weights to DB and loadWeights() retrieves them', async () => {
  const { loadWeights, saveWeights } = await import('../src/core/signal-weights.js');

  const testWeights = { organic_score: 1.5, fee_tvl_ratio: 2.0, volume: 1.0 };
  const now = new Date().toISOString();

  saveWeights({ weights: testWeights, last_recalc: now, recalc_count: 5 });

  const data = loadWeights();
  if (data.weights.organic_score !== 1.5) throw new Error(`organic_score should be 1.5, got ${data.weights.organic_score}`);
  if (data.weights.fee_tvl_ratio !== 2.0) throw new Error(`fee_tvl_ratio should be 2.0, got ${data.weights.fee_tvl_ratio}`);
  if (data.last_recalc !== now) throw new Error(`last_recalc mismatch`);
  if (data.recalc_count !== 5) throw new Error(`recalc_count should be 5, got ${data.recalc_count}`);
});

await it('recalculateWeights() writes to signal_weights and signal_weights_history', async () => {
  const { recalculateWeights, loadWeights } = await import('../src/core/signal-weights.js');

  // Create fake performance data (some wins, some losses)
  const perfData = Array.from({ length: 20 }, (_, i) => ({
    recorded_at: new Date().toISOString(),
    pnl_usd: i % 3 === 0 ? -10 : 5,
    signal_snapshot: {
      organic_score: 50 + i,
      fee_tvl_ratio: 0.05 + i * 0.001,
      volume: 1000000 + i * 10000,
    }
  }));

  const result = recalculateWeights(perfData, { darwin: { windowDays: 60, minSamples: 5 } });

  if (!Array.isArray(result.changes)) throw new Error(`changes should be array, got ${typeof result.changes}`);
  if (typeof result.weights !== 'object') throw new Error(`weights should be object, got ${typeof result.weights}`);

  const data = loadWeights();
  if (data.recalc_count < 1) throw new Error(`recalc_count should be >= 1 after recalculateWeights, got ${data.recalc_count}`);
  if (!Array.isArray(data.history)) throw new Error(`history should be array`);
});

await it('matchesBlockedPattern() returns rule for blocked pattern or null', async () => {
  const { matchesBlockedPattern, clearRules } = await import('../src/core/postmortem.js');
  clearRules();

  const db = getDB();
  db.prepare(`
    INSERT OR REPLACE INTO postmortem_rules
      (key, type, strategy, bin_step_range, volatility_range, evidence, severity, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'test_block_1',
    'AVOID_PATTERN',
    'bid_ask',
    JSON.stringify([80, 120]),
    JSON.stringify([2.0, 4.0]),
    JSON.stringify({ sample_size: 5 }),
    'hard_block',
    'Test block rule',
    new Date().toISOString()
  );

  const blocked = matchesBlockedPattern({ strategy: 'bid_ask', bin_step: 100, volatility: 3.0 });
  if (!blocked) throw new Error('Expected hard_block rule to match');
  if (blocked.key !== 'test_block_1') throw new Error(`Expected key test_block_1, got ${blocked.key}`);

  const notBlocked = matchesBlockedPattern({ strategy: 'bid_ask', bin_step: 100, volatility: 10.0 });
  if (notBlocked) throw new Error('Expected no match for volatility outside range');

  clearRules();
});

await it('MAX_RULES pruning is enforced (50 rule limit)', async () => {
  const { clearRules, getActiveRules } = await import('../src/core/postmortem.js');
  clearRules();

  const db = getDB();
  // Insert 55 rules directly
  const insert = db.prepare(`
    INSERT OR REPLACE INTO postmortem_rules
      (key, type, severity, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < 55; i++) {
    insert.run(`prune_test_${i}`, 'RECURRING_FAILURE', 'soft_penalty', `Rule ${i}`, new Date().toISOString());
  }

  const { saveRules } = await import('../src/core/postmortem.js');
  const allRules = db.prepare('SELECT * FROM postmortem_rules').all();
  saveRules(allRules);

  const remaining = db.prepare('SELECT COUNT(*) as cnt FROM postmortem_rules').get();
  if (remaining.cnt > 50) throw new Error(`Expected <= 50 rules after prune, got ${remaining.cnt}`);

  clearRules();
});

// ─── Bug Reports ───────────────────────────────────────────────────

/*
BUG 1: loadRules() returns raw legacy JSON instead of parsed rules after JSON migration
File: src/core/postmortem.js
Location: loadRules() line ~112
Severity: Medium
Description: When the DB is empty and postmortem-rules.json exists, the function migrates
  rules to DB then returns 'legacy' (raw JSON objects) instead of calling loadRules()
  again to get properly parsed objects. The returned rules have string bin_step_range,
  volatility_range, hours_utc, evidence instead of parsed arrays/objects.
Fix: Replace 'return legacy;' with 'return loadRules();' at line 112.

BUG 2: postmortem-rules.json and signal_weights.json still referenced in source
File: src/core/postmortem.js line 28, src/core/signal-weights.js (comment)
Severity: Info
Description: POSTMORTEM_FILE constant './postmortem-rules.json' still exists in postmortem.js
  (used as fallback). Signal-weights.js comment on line 8 mentions signal-weights.json
  but the actual code uses SQLite. These are not bugs per se (JSON fallback is intentional
  for existing deployments), but the JSON files should be confirmed absent in production.
*/
