/**
 * Lesson service — orchestration layer for recordPerformance and learning stats.
 *
 * Extracted from src/core/lessons.js
 */

import crypto from "crypto";
import fs from "fs";
import { getDB } from "./db.js";
import { log } from "./logger.js";
import { USER_CONFIG_PATH } from "../config.js";
import { MIN_EVOLVE_POSITIONS } from "./threshold-evolver.js";
import { evolveThresholds } from "./threshold-evolver.js";
import { recalculateDarwinWeights } from "./darwin-weights.js";

// ─── Constants ──────────────────────────────────────────────────

export const PERFORMANCE_ARCHIVE_THRESHOLD = 200;
export const PERFORMANCE_KEEP = 100;
export const NEAR_MISS_MAX_DAYS = 90;

// ─── Core Orchestration ─────────────────────────────────────────

/**
 * Record a closed position's performance and trigger auto-evolution.
 * Persists to performance table, derives a lesson, triggers threshold evolution
 * every MIN_EVOLVE_POSITIONS closes, prunes old records, and syncs to hive mind.
 * @param {Object} perf - Performance record
 * @returns {Promise<void>}
 */
export async function recordPerformance(perf) {
  const db = getDB();

  const isDataCorrupt =
    (Number.isFinite(perf.final_value_usd) && perf.final_value_usd <= 0) ||
    (Number.isFinite(perf.initial_value_usd) && perf.initial_value_usd <= 0) ||
    (Number.isFinite(perf.final_value_usd) && Number.isFinite(perf.initial_value_usd)
      && perf.final_value_usd > perf.initial_value_usd * 100);

  if (isDataCorrupt) {
    log("warn", "lessons", `Skipped corrupt performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? Math.min(100, (perf.minutes_in_range / perf.minutes_held) * 100)
    : 0;

  const entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  db.transaction(() => {
    db.prepare(`
      INSERT INTO performance (
        position, pool, pool_name, strategy, bin_range, bin_step, volatility,
        fee_tvl_ratio, organic_score, amount_sol, fees_earned_usd, final_value_usd,
        initial_value_usd, minutes_in_range, minutes_held, close_reason, pnl_usd,
        pnl_pct, range_efficiency, deployed_at, closed_at, recorded_at, base_mint
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      entry.position, entry.pool, entry.pool_name, entry.strategy, JSON.stringify(entry.bin_range),
      entry.bin_step, entry.volatility, entry.fee_tvl_ratio, entry.organic_score, entry.amount_sol,
      entry.fees_earned_usd, entry.final_value_usd, entry.initial_value_usd, entry.minutes_in_range,
      entry.minutes_held, entry.close_reason, entry.pnl_usd, entry.pnl_pct, entry.range_efficiency,
      entry.deployed_at, entry.closed_at, entry.recorded_at, entry.base_mint
    );

    const lesson = derivLesson(entry);
    if (lesson) {
      db.prepare(`
        INSERT INTO lessons (
          id, rule, tags, outcome, context, pnl_pct, range_efficiency, pool, created_at, pinned, role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lesson.id, lesson.rule, JSON.stringify(lesson.tags), lesson.outcome, lesson.context,
        lesson.pnl_pct, lesson.range_efficiency, lesson.pool, lesson.created_at, 0, null
      );
      log("info", "lessons", `New lesson: ${lesson.rule}`);
    }
  })();

  if (perf.pool) {
    const { recordPoolDeploy } = await import("../features/pool-memory.js");
    await recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  const allPerformance = db.prepare('SELECT * FROM performance').all();

  try {
    const { analyzeClose } = await import("./postmortem.js");
    analyzeClose(entry, allPerformance);
  } catch (e) {
    log("error", "postmortem", `Post-mortem analysis failed: ${e.message}`);
  }

  if (allPerformance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("../config.js");
    const result = evolveThresholds(allPerformance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("info", "evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    await recalculateDarwinWeights(allPerformance, config);
  }

  import("../features/hive-mind.js").then(m => m.syncToHive()).catch(e => log("warn", "hive-mind", `syncToHive failed: ${e?.message}`));

  // Auto-prune performance data and near-misses
  try {
    const pruningResult = prunePerformance();
    if (pruningResult.archived > 0) {
      log("info", "lessons", `Pruning: archived ${pruningResult.archived} records`);
    }
    pruneNearMisses();
  } catch (e) {
    log("warn", "lessons", `Pruning failed: ${e.message}`);
  }
}

// ─── Lesson Derivation ──────────────────────────────────────────

export function derivLesson(perf) {
  const tags = [];
  const outcome = perf.pnl_pct >= 5 ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") {
    const db = getDB();
    const id = crypto.randomUUID();
    const range_eff = perf.minutes_held > 0
      ? Math.min(100, (perf.minutes_in_range / perf.minutes_held) * 100)
      : 0;
    db.prepare(`
      INSERT OR IGNORE INTO near_misses (
        id, position, pool, strategy, bin_step, volatility,
        fee_tvl_ratio, organic_score, pnl_usd, pnl_pct,
        minutes_in_range, minutes_held, range_efficiency,
        close_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, perf.position, perf.pool, perf.strategy, perf.bin_step,
      perf.volatility, perf.fee_tvl_ratio, perf.organic_score,
      perf.pnl_usd, perf.pnl_pct, perf.minutes_in_range,
      perf.minutes_held, Math.round(range_eff * 10) / 10,
      perf.close_reason, new Date().toISOString()
    );
    log("info", "lessons", "Neutral outcome recorded in near_misses");
    return null;
  }

  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
       rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
       rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
       rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
       rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  return {
    id: crypto.randomUUID(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Performance Pruning ─────────────────────────────────────────

export function prunePerformance() {
  const db = getDB();
  const count = db.prepare('SELECT COUNT(*) as c FROM performance').get().c;
  if (count <= PERFORMANCE_ARCHIVE_THRESHOLD) return { archived: 0, reason: "below threshold" };

  const toArchive = count - PERFORMANCE_KEEP;
  const oldest = db.prepare(
    'SELECT id FROM performance ORDER BY recorded_at ASC LIMIT ?'
  ).all(toArchive).map(r => r.id);

  if (oldest.length === 0) return { archived: 0 };

  const archivedAt = new Date().toISOString();
  const archiveStmt = db.prepare(`
    INSERT INTO performance_archive
    SELECT *, ? FROM performance WHERE id = ?
  `);
  const deleteStmt = db.prepare('DELETE FROM performance WHERE id = ?');

  db.transaction(() => {
    for (const id of oldest) {
      archiveStmt.run(archivedAt, id);
      deleteStmt.run(id);
    }
  })();

  log("info", "lessons", `Archived ${oldest.length} performance records to performance_archive`);
  return { archived: oldest.length };
}

export function pruneNearMisses() {
  const db = getDB();
  const cutoff = new Date(Date.now() - NEAR_MISS_MAX_DAYS * 86400000).toISOString();
  const { changes } = db.prepare('DELETE FROM near_misses WHERE created_at < ?').run(cutoff);
  if (changes > 0) {
    log("info", "lessons", `Pruned ${changes} near_misses older than ${NEAR_MISS_MAX_DAYS} days`);
  }
  return { pruned: changes };
}

// ─── Learning Stats ──────────────────────────────────────────────

export function getLearningStats() {
  const db = getDB();

  const perfCount = db.prepare('SELECT COUNT(*) as c FROM performance').get().c;
  const nearMissCount = db.prepare('SELECT COUNT(*) as c FROM near_misses').get().c;
  const lessonCount = db.prepare('SELECT COUNT(*) as c FROM lessons').get().c;
  const archivedCount = db.prepare('SELECT COUNT(*) as c FROM performance_archive').get().c;

  const perfStats = db.prepare(`
    SELECT COUNT(*) as count, SUM(pnl_usd) as total_pnl, SUM(pnl_pct) as pt_sum
    FROM performance
  `).get();
  const wins = db.prepare('SELECT COUNT(*) as wins FROM performance WHERE pnl_usd > 0').get().wins;

  const nearMissAvg = db.prepare('SELECT AVG(pnl_pct) as avg_pnl, COUNT(*) as c FROM near_misses').get();

  const pinnedCount = db.prepare('SELECT COUNT(*) as c FROM lessons WHERE pinned = 1').get().c;
  const ratedUseful = db.prepare("SELECT COUNT(*) as c FROM lessons WHERE rating = 'useful'").get().c;
  const ratedUseless = db.prepare("SELECT COUNT(*) as c FROM lessons WHERE rating = 'useless'").get().c;

  const evolutionCount = db.prepare("SELECT COUNT(*) as c FROM lessons WHERE outcome = 'evolution'").get().c;

  const thresholds = {};
  try {
    const cfgPath = USER_CONFIG_PATH;
    if (fs.existsSync(cfgPath)) {
      const uc = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      thresholds.maxBinStep = uc.maxBinStep ?? "n/a";
      thresholds.minFeeActiveTvlRatio = uc.minFeeActiveTvlRatio ?? "n/a";
      thresholds.minOrganic = uc.minOrganic ?? "n/a";
    }
  } catch { /* ignore */ }

  return {
    performance_records: perfCount,
    near_misses: nearMissCount,
    total_lessons: lessonCount,
    archived_records: archivedCount,
    overall_win_rate: perfCount > 0 ? Math.round((wins / perfCount) * 100) : null,
    total_pnl_usd: Math.round((perfStats.total_pnl || 0) * 100) / 100,
    avg_pnl_pct: perfCount > 0 ? Math.round(((perfStats.pt_sum || 0) / perfCount) * 100) / 100 : null,
    near_miss_avg_pnl_pct: nearMissCount > 0 ? Math.round(nearMissAvg.avg_pnl * 100) / 100 : null,
    pinned_lessons: pinnedCount,
    rated_useful: ratedUseful,
    rated_useless: ratedUseless,
    evolution_cycles: evolutionCount,
    current_thresholds: thresholds,
  };
}

// ─── Performance History & Summary ─────────────────────────────

export function getPerformanceSummary() {
  const db = getDB();
  const stats = db.prepare(`
    SELECT COUNT(*) as count, SUM(pnl_usd) as total_pnl, SUM(pnl_pct) as pt_sum, SUM(range_efficiency) as eff_sum
    FROM performance
  `).get();

  const count = stats.count || 0;
  if (count === 0) return null;

  const wins = db.prepare('SELECT COUNT(*) as wins FROM performance WHERE pnl_usd > 0').get().wins;
  const totalLessons = db.prepare('SELECT COUNT(*) as c FROM lessons').get().c;

  return {
    total_positions_closed: count,
    total_pnl_usd: Math.round((stats.total_pnl || 0) * 100) / 100,
    avg_pnl_pct: Math.round(((stats.pt_sum||0) / count) * 100) / 100,
    avg_range_efficiency_pct: Math.round(((stats.eff_sum||0) / count) * 10) / 10,
    win_rate_pct: Math.round((wins / count) * 100),
    total_lessons: totalLessons,
  };
}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const db = getDB();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = db.prepare('SELECT * FROM performance WHERE recorded_at >= ? LIMIT ?').all(cutoff, limit).map((r) => ({
    pool_name: r.pool_name,
    pool: r.pool,
    strategy: r.strategy,
    pnl_usd: r.pnl_usd,
    pnl_pct: r.pnl_pct,
    fees_earned_usd: r.fees_earned_usd,
    range_efficiency: r.range_efficiency,
    minutes_held: r.minutes_held,
    close_reason: r.close_reason,
    closed_at: r.recorded_at,
  }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}