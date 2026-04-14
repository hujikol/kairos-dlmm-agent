/**
 * Post-mortem analysis engine.
 *
 * Runs after every position close (called from recordPerformance).
 * Produces structured, actionable rules that are:
 *   1. Injected into the SCREENER prompt as hard warnings
 *   2. Used by the screening pipeline to skip losing patterns
 *
 * Unlike text-based lessons ("AVOID X-type pools"), postmortem rules
 * are quantitative and programmatically enforceable.
 *
 * Rules are persisted to SQLite (postmortem_rules table). The legacy
 * postmortem-rules.json file is read as a one-time fallback for existing
 * deployments, then superseded by DB storage.
 */

import fs from "fs";
import crypto from "crypto";
import { log } from "./logger.js";
import { getDB } from "./db.js";

/** Coerce a value to a safe SQLite REAL (null when NaN or Infinity). */
function safeNum(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return v;
}

const POSTMORTEM_FILE = "./postmortem-rules.json";
const MAX_RULES = 50;

function ensureTable(db) {
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
}

function loadRules() {
  const db = getDB();
  ensureTable(db);

  // Try DB first
  try {
    const rows = db.prepare("SELECT * FROM postmortem_rules ORDER BY created_at ASC").all();
    if (rows.length > 0) {
      return rows.map(row => ({
        ...row,
        bin_step_range: row.bin_step_range ? JSON.parse(row.bin_step_range) : null,
        volatility_range: row.volatility_range ? JSON.parse(row.volatility_range) : null,
        hours_utc: row.hours_utc ? JSON.parse(row.hours_utc) : null,
        evidence: row.evidence ? JSON.parse(row.evidence) : null,
      }));
    }
  } catch (e) {
    log("warn", "postmortem", `Failed to load rules from DB: ${e?.message}`);
  }

  // Fallback: one-time migration from legacy JSON file
  if (!fs.existsSync(POSTMORTEM_FILE)) return [];
  try {
    const legacy = JSON.parse(fs.readFileSync(POSTMORTEM_FILE, "utf8"));
    if (!Array.isArray(legacy) || legacy.length === 0) return [];

    // Migrate each rule to DB
    const insert = db.prepare(`
      INSERT OR REPLACE INTO postmortem_rules
        (key, type, strategy, bin_step_range, volatility_range, reason, frequency, count,
         hours_utc, win_rate, sample_size, evidence, severity, description, suggestion, created_at, updated_at)
      VALUES
        (@key, @type, @strategy, @bin_step_range, @volatility_range, @reason, @frequency, @count,
         @hours_utc, @win_rate, @sample_size, @evidence, @severity, @description, @suggestion, @created_at, @updated_at)
    `);
    for (const rule of legacy) {
      insert.run({
        key: rule.key,
        type: rule.type,
        strategy: rule.strategy || null,
        bin_step_range: rule.bin_step_range ? JSON.stringify(rule.bin_step_range) : null,
        volatility_range: rule.volatility_range ? JSON.stringify(rule.volatility_range) : null,
        reason: rule.reason || null,
        frequency: rule.frequency || null,
        count: rule.count || null,
        hours_utc: rule.hours_utc ? JSON.stringify(rule.hours_utc) : null,
        win_rate: rule.win_rate || null,
        sample_size: rule.evidence?.sample_size || null,
        evidence: rule.evidence ? JSON.stringify(rule.evidence) : null,
        severity: rule.severity,
        description: rule.description,
        suggestion: rule.suggestion || null,
        created_at: rule.created_at || new Date().toISOString(),
        updated_at: rule.updated_at || null,
      });
    }
    log("info", "postmortem", `Migrated ${legacy.length} rules from JSON to SQLite`);
    return loadRules(); // re-query DB so returned rules have parsed JSON fields
  } catch (e) {
    log("warn", "postmortem", `Failed to read postmortem JSON fallback: ${e?.message}`);
    return [];
  }
}

function saveRules(rules) {
  const db = getDB();
  ensureTable(db);

  const trimmed = rules.slice(-MAX_RULES);

  // Upsert each rule into DB
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO postmortem_rules
      (key, type, strategy, bin_step_range, volatility_range, reason, frequency, count,
       hours_utc, win_rate, sample_size, evidence, severity, description, suggestion, created_at, updated_at)
    VALUES
      (@key, @type, @strategy, @bin_step_range, @volatility_range, @reason, @frequency, @count,
       @hours_utc, @win_rate, @sample_size, @evidence, @severity, @description, @suggestion, @created_at, @updated_at)
  `);

  const tx = db.transaction(() => {
    for (const rule of trimmed) {
      upsert.run({
        key: rule.key,
        type: rule.type,
        strategy: rule.strategy || null,
        bin_step_range: rule.bin_step_range ? JSON.stringify(rule.bin_step_range) : null,
        volatility_range: rule.volatility_range ? JSON.stringify(rule.volatility_range) : null,
        reason: rule.reason || null,
        frequency: rule.frequency || null,
        count: rule.count || null,
        hours_utc: rule.hours_utc ? JSON.stringify(rule.hours_utc) : null,
        win_rate: rule.win_rate || null,
        sample_size: rule.evidence?.sample_size || null,
        evidence: rule.evidence ? JSON.stringify(rule.evidence) : null,
        severity: rule.severity,
        description: rule.description,
        suggestion: rule.suggestion || null,
        created_at: rule.created_at || new Date().toISOString(),
        updated_at: rule.updated_at || null,
      });
    }
    // Prune old rules beyond MAX_RULES
    db.prepare(`DELETE FROM postmortem_rules WHERE key NOT IN (SELECT key FROM postmortem_rules ORDER BY created_at DESC LIMIT ${MAX_RULES})`).run();
  });
  tx();
}

// ─── Core Analysis ──────────────────────────────────────────────

/**
 * Analyze a closed position against all past performance.
 * Returns an array of hard rules to enforce.
 *
 * @param {Object} perfRecord - The just-closed position's performance
 * @param {Array}  allPerformance - All historical performance records
 * @returns {Array} Array of rule objects
 */
export function analyzeClose(perfRecord, allPerformance) {
  const newRules = [];

  // Only analyze losing positions — winners don't need post-mortems
  if (perfRecord.pnl_pct >= 0) {
    // Still write a positive autopsy to the lessons table
    writeAutopsyToLessons(perfRecord, allPerformance);
    return newRules;
  }

  // 1. Pattern detection: strategy × bin_step × volatility combos
  const patternRule = detectLosingPattern(perfRecord, allPerformance);
  if (patternRule) newRules.push(patternRule);

  // 2. Close reason clustering — same failure mode repeating
  const failureRule = detectRecurringFailure(allPerformance);
  if (failureRule) newRules.push(failureRule);

  // 3. Time-of-day patterns
  const timeRule = detectTimePattern(perfRecord, allPerformance);
  if (timeRule) newRules.push(timeRule);

  if (newRules.length > 0) {
    // Merge into persisted rules (dedup by key)
    const existing = loadRules();
    const existingKeys = new Set(existing.map(r => r.key));

    for (const rule of newRules) {
      if (existingKeys.has(rule.key)) {
        // Update existing rule with fresh evidence
        const idx = existing.findIndex(r => r.key === rule.key);
        existing[idx] = { ...existing[idx], ...rule, updated_at: new Date().toISOString() };
      } else {
        existing.push({ ...rule, created_at: new Date().toISOString() });
      }
    }

    saveRules(existing);
    log("info", "postmortem", `Generated ${newRules.length} rule(s) from close of ${perfRecord.pool_name}`);
  }

  // Always write autopsy to lessons table
  writeAutopsyToLessons(perfRecord, allPerformance);

  return newRules;
}

// ─── Pattern Detection ──────────────────────────────────────────

function detectLosingPattern(perfRecord, allPerformance) {
  if (!perfRecord.strategy || !perfRecord.bin_step || !perfRecord.volatility) return null;

  // Find similar positions (same strategy, similar bin_step and volatility)
  const similar = allPerformance.filter(p =>
    p.strategy === perfRecord.strategy &&
    p.bin_step != null && Math.abs(p.bin_step - perfRecord.bin_step) <= 10 &&
    p.volatility != null && Math.abs(p.volatility - perfRecord.volatility) <= 2.0
  );

  if (similar.length < 3) return null;

  const winRate = similar.filter(p => p.pnl_pct > 0).length / similar.length;
  const avgPnl = similar.reduce((s, p) => s + p.pnl_pct, 0) / similar.length;

  if (winRate < 0.33 && avgPnl < -3) {
    const key = `pattern_${perfRecord.strategy}_bs${Math.round(perfRecord.bin_step / 10) * 10}_vol${Math.round(perfRecord.volatility)}`;
    return {
      type: "AVOID_PATTERN",
      key,
      strategy: perfRecord.strategy,
      bin_step_range: [perfRecord.bin_step - 10, perfRecord.bin_step + 10],
      volatility_range: [perfRecord.volatility - 2.0, perfRecord.volatility + 2.0],
      evidence: {
        sample_size: similar.length,
        win_rate: Math.round(winRate * 100),
        avg_pnl: Math.round(avgPnl * 100) / 100,
      },
      severity: avgPnl < -10 ? "hard_block" : "soft_penalty",
      description: `${perfRecord.strategy} with bin_step ~${perfRecord.bin_step} and volatility ~${perfRecord.volatility.toFixed(1)}: ${Math.round(winRate * 100)}% win rate, ${avgPnl.toFixed(1)}% avg PnL across ${similar.length} positions`,
    };
  }

  return null;
}

function detectRecurringFailure(allPerformance) {
  const recentLosses = allPerformance
    .filter(p => p.pnl_pct < -5)
    .slice(-10);

  if (recentLosses.length < 3) return null;

  const reasonCounts = {};
  for (const loss of recentLosses) {
    const r = normalizeCloseReason(loss.close_reason || "unknown");
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }

  for (const [reason, count] of Object.entries(reasonCounts)) {
    const frequency = count / recentLosses.length;
    if (frequency > 0.6 && count >= 3) {
      return {
        type: "RECURRING_FAILURE",
        key: `failure_${reason}`,
        reason,
        frequency: Math.round(frequency * 100),
        count,
        severity: "soft_penalty",
        suggestion: getRemediationForReason(reason),
        description: `${count}/${recentLosses.length} recent losses closed due to "${reason}" — ${getRemediationForReason(reason)}`,
      };
    }
  }

  return null;
}

function detectTimePattern(perfRecord, allPerformance) {
  if (!perfRecord.deployed_at) return null;

  const hour = new Date(perfRecord.deployed_at).getUTCHours();

  const sameHourTrades = allPerformance.filter(p => {
    if (!p.deployed_at) return false;
    const h = new Date(p.deployed_at).getUTCHours();
    return Math.abs(h - hour) <= 2 || Math.abs(h - hour) >= 22; // handle wrap-around
  });

  if (sameHourTrades.length < 5) return null;

  const hourWinRate = sameHourTrades.filter(p => p.pnl_pct > 0).length / sameHourTrades.length;

  if (hourWinRate < 0.25) {
    return {
      type: "AVOID_TIME_WINDOW",
      key: `time_${hour}`,
      hours_utc: [(hour - 2 + 24) % 24, (hour + 2) % 24],
      win_rate: Math.round(hourWinRate * 100),
      sample_size: sameHourTrades.length,
      severity: "soft_penalty",
      description: `Deploys around ${hour}:00 UTC have only ${Math.round(hourWinRate * 100)}% win rate (${sameHourTrades.length} samples)`,
    };
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────

function normalizeCloseReason(reason) {
  const r = reason.toLowerCase();
  if (r.includes("stop") || r.includes("loss")) return "stop_loss";
  if (r.includes("range") || r.includes("oor")) return "out_of_range";
  if (r.includes("yield") || r.includes("fee")) return "low_yield";
  if (r.includes("trail")) return "trailing_tp";
  if (r.includes("volume")) return "volume_collapse";
  return reason.toLowerCase().replace(/\s+/g, "_").slice(0, 30);
}

function getRemediationForReason(reason) {
  const map = {
    out_of_range: "Widen bin_range or switch to bid_ask strategy for volatile tokens",
    stop_loss: "Tighten entry criteria — require stronger narrative + smart wallet presence",
    low_yield: "Raise minFeeActiveTvlRatio threshold; wait for fee/TVL confirmation over 15m",
    trailing_tp: "Working as designed — trailing TP is a controlled exit",
    volume_collapse: "Check volume trend (15m vs 5m) before deploying; require sustained volume",
  };
  return map[reason] || "Review deployment criteria for this type of close";
}

// ─── Query API ──────────────────────────────────────────────────

/**
 * Get all active postmortem rules.
 * Used by screening pipeline and prompt injection.
 */
export function getActiveRules() {
  return loadRules();
}

/**
 * Get rules formatted for LLM prompt injection.
 * Only includes rules with enough evidence and recent activity.
 */
export function getRulesForPrompt() {
  const rules = loadRules();
  if (rules.length === 0) return null;

  const lines = rules
    .filter(r => r.severity === "hard_block" || r.evidence?.sample_size >= 3)
    .map(r => {
      const icon = r.severity === "hard_block" ? "🚫" : "⚠️";
      return `${icon} [${r.type}] ${r.description}`;
    });

  if (lines.length === 0) return null;
  return `POST-MORTEM RULES (learned from past losses):\n${lines.join("\n")}`;
}

/**
 * Check if a candidate matches any hard-block pattern.
 * Returns the blocking rule or null.
 *
 * @param {Object} candidate - { strategy, bin_step, volatility }
 */
export function matchesBlockedPattern(candidate) {
  const rules = loadRules();

  for (const rule of rules) {
    if (rule.type !== "AVOID_PATTERN" || rule.severity !== "hard_block") continue;

    const strategyMatch = !rule.strategy || rule.strategy === candidate.strategy;
    const binStepMatch = !rule.bin_step_range || (
      candidate.bin_step >= rule.bin_step_range[0] &&
      candidate.bin_step <= rule.bin_step_range[1]
    );
    const volMatch = !rule.volatility_range || (
      candidate.volatility >= rule.volatility_range[0] &&
      candidate.volatility <= rule.volatility_range[1]
    );

    if (strategyMatch && binStepMatch && volMatch) {
      return rule;
    }
  }

  return null;
}

/**
 * Clear all postmortem rules.
 */
export function clearRules() {
  saveRules([]);
  return { cleared: true };
}

// ─── Enhanced Autopsy ───────────────────────────────────────────

/**
 * Write a detailed post-mortem analysis to the lessons table.
 * Includes comparisons against pool history, volatility-class strategy
 * performance, and a confidence score based on data volume.
 */
function writeAutopsyToLessons(perfRecord, allPerformance) {
  const db = getDB();
  const lines = [];
  const { pnl_pct, pnl_usd, strategy, bin_step, volatility, pool_name, close_reason, minutes_held } = perfRecord;
  const outcome = pnl_pct >= 0 ? "postmortem" : "postmortem_loss";

  // 1. Pool-level comparison
  const poolHistory = allPerformance.filter(p =>
    p.pool === perfRecord.pool || (p.pool_name && perfRecord.pool_name && p.pool_name === perfRecord.pool_name)
  );
  if (poolHistory.length > 0) {
    const poolAvgPnl = poolHistory.reduce((s, p) => s + (p.pnl_pct || 0), 0) / poolHistory.length;
    const poolWinRate = poolHistory.filter(p => p.pnl_pct > 0).length / poolHistory.length;
    lines.push(`Pool ${pool_name || "unknown"} history: ${poolHistory.length} trades, avg PnL ${poolAvgPnl.toFixed(2)}%, win rate ${Math.round(poolWinRate * 100)}%`);
    if (pnl_pct < poolAvgPnl - 5) {
      lines.push(`This close (${pnl_pct}%) underperforms pool average by ${(poolAvgPnl - pnl_pct).toFixed(1)}pp`);
    }
  }

  // 2. Volatility-class strategy comparison
  const volClass = volatility < 3 ? "low (<3)" : volatility < 7 ? "medium (3-7)" : "high (>=7)";
  const volSimilar = allPerformance.filter(p => {
    const vc = p.volatility < 3 ? "low" : p.volatility < 7 ? "medium" : "high";
    const myVolClass = volatility < 3 ? "low" : volatility < 7 ? "medium" : "high";
    return vc === myVolClass && p.strategy === strategy;
  });
  if (volSimilar.length > 0) {
    const bestPnl = Math.max(...volSimilar.map(p => p.pnl_pct));
    const avgPnl = volSimilar.reduce((s, p) => s + (p.pnl_pct || 0), 0) / volSimilar.length;
    lines.push(`Volatility class ${volClass}, strategy ${strategy}: ${volSimilar.length} trades, avg PnL ${avgPnl.toFixed(2)}%, best ${bestPnl.toFixed(2)}%`);
    if (pnl_pct < avgPnl * 0.5 && avgPnl < -2) {
      lines.push(`AVOID: ${strategy} in ${volClass} volatility conditions — avg PnL is negative`);
    }
  }

  // 3. Confidence score based on supporting data
  const similarCount = volSimilar.length + (poolHistory?.length || 0);
  let confidence = "low";
  if (similarCount >= 10) confidence = "high";
  else if (similarCount >= 5) confidence = "medium";

  // Build the autopsy rule string
  const closeInfo = `${pool_name || "?"} — PnL ${pnl_pct}% ($${(pnl_usd || 0).toFixed(2)}), ${close_reason || "unknown"}`;
  const contextInfo = `strategy=${strategy}, bin_step=${bin_step}, vol=${volatility}, held ${Math.round(minutes_held || 0)}m`;
  const analysisDetail = lines.length > 0 ? lines.join("; ") : "No comparable historical data for this pool/volatility class";

  const rule = `AUTOPSY [${confidence.toUpperCase()} CONFIDENCE]: ${closeInfo} | ${contextInfo} | ${analysisDetail}`;

  // Tag the lesson
  const tags = ["postmortem", strategy, `vol_${Math.round(volatility)}`];
  if (volSimilar.length < 3) tags.push("limited_data");

  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, context, pnl_pct, range_efficiency, pool, created_at, pinned, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    rule,
    JSON.stringify(tags),
    "postmortem",
    JSON.stringify({ close_reason, strategy, bin_step, volatility, confidence, similar_count: similarCount }),
    safeNum(pnl_pct),
    safeNum(perfRecord.range_efficiency) ?? 0,
    perfRecord.pool,
    new Date().toISOString(),
    0,
    null
  );
}
