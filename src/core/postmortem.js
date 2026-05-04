/**
 * Post-mortem analysis engine — barrel re-export.
 *
 * Runs after every position close (called from recordPerformance).
 * Produces structured, actionable rules that are:
 *   1. Injected into the SCREENER prompt as hard warnings
 *   2. Used by the screening pipeline to skip losing patterns
 *
 * Rules are persisted to SQLite (postmortem_rules table). The legacy
 * postmortem-rules.json file is read as a one-time fallback for existing
 * deployments, then superseded by DB storage.
 */

import { log } from "./logger.js";
import { getDB } from "./db.js";
import { loadRules, saveRules } from "./postmortem/store.js";
import { detectLosingPattern, detectRecurringFailure, detectTimePattern } from "./postmortem/rules.js";
import { writeAutopsyToLessons } from "./postmortem/autopsy.js";

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
    const existing = loadRules();
    const existingKeys = new Set(existing.map(r => r.key));

    for (const rule of newRules) {
      if (existingKeys.has(rule.key)) {
        const idx = existing.findIndex(r => r.key === rule.key);
        existing[idx] = { ...existing[idx], ...rule, updated_at: new Date().toISOString() };
      } else {
        existing.push({ ...rule, created_at: new Date().toISOString() });
      }
    }

    saveRules(existing);
    log("info", "postmortem", `Generated ${newRules.length} rule(s) from close of ${perfRecord.pool_name}`);
  }

  writeAutopsyToLessons(perfRecord, allPerformance);

  return newRules;
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
  const db = getDB();
  db.prepare("DELETE FROM postmortem_rules").run();
  return { cleared: true };
}

// Re-export submodules for consumers that need direct access
export {
  detectLosingPattern,
  detectRecurringFailure,
  detectTimePattern,
  normalizeCloseReason,
  getRemediationForReason,
} from "./postmortem/rules.js";

export { loadRules, saveRules } from "./postmortem/store.js";
export { writeAutopsyToLessons } from "./postmortem/autopsy.js";