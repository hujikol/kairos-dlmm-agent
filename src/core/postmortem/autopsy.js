/**
 * Post-mortem autopsy generation and writing to lessons table.
 *
 * writeAutopsyToLessons produces a detailed analysis of a closed position,
 * comparing it against pool history and volatility-class strategy performance,
 * then persists it as a lesson in the SQLite lessons table.
 */

import crypto from "crypto";
import { getDB } from "../db.js";
import { log } from "../logger.js";

/** Coerce a value to a safe SQLite REAL (null when NaN or Infinity). */
function safeNum(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return v;
}

/**
 * Write a detailed post-mortem analysis to the lessons table.
 * Includes comparisons against pool history, volatility-class strategy
 * performance, and a confidence score based on data volume.
 * @param {Object} perfRecord
 * @param {Array} allPerformance
 */
export function writeAutopsyToLessons(perfRecord, allPerformance) {
  const db = getDB();
  const lines = [];
  const { pnl_pct, pnl_usd, strategy, bin_step, volatility, pool_name, close_reason, minutes_held } = perfRecord;

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

  try {
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
  } catch (e) {
    log("warn", "postmortem", `writeAutopsyToLessons: failed to insert lesson: ${e?.message}`);
  }
}