/**
 * Agent learning system.
 * Backed by SQLite (meridian.db).
 */

import fs from "fs";
import crypto from "crypto";
import writeFileAtomic from "write-file-atomic";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getDB } from "./db.js";
import { USER_CONFIG_PATH } from "../config.js";


const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once

// ─── Record Position Performance ──────────────────────────────

export async function recordPerformance(perf) {
  const db = getDB();

  // Only skip records that clearly indicate broken data (e.g. zero or negative final value
  // when we know the position held value, or final value exceeding 100x the deployed amount
  // which almost certainly means the API returned the wrong unit).
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
    recordPoolDeploy(perf.pool, {
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

    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(allPerformance, config);
      if (wResult.changes.length > 0) {
        log("info", "evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  import("../features/hive-mind.js").then(m => m.syncToHive()).catch(() => {});

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

function derivLesson(perf) {
  const tags = [];
  const outcome = perf.pnl_pct >= 5 ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") {
    // Insert into near_misses instead of discarding
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

export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);

  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  {
    const winnerBinSteps = winners.map((p) => p.bin_step).filter(isFiniteNum);
    const loserBinSteps  = losers.map((p) => p.bin_step).filter(isFiniteNum);
    const current        = config.screening.maxBinStep;

    if (loserBinSteps.length >= 2) {
      const loserP25 = percentile(loserBinSteps, 25);
      if (loserP25 < current) {
        const target  = loserP25 * 1.05;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 60, 200);
        const rounded = Math.round(newVal);
        if (rounded < current) {
          changes.maxBinStep = rounded;
          rationale.maxBinStep = `Losers clustered at bin_step ~${loserP25.toFixed(0)} — tightened from ${current} → ${rounded}`;
        }
      }
    } else if (winnerBinSteps.length >= 3 && losers.length === 0) {
      const winnerP75 = percentile(winnerBinSteps, 75);
      if (winnerP75 > current * 1.05) {
        const target  = winnerP75 * 1.05;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 60, 200);
        const rounded = Math.round(newVal);
        if (rounded > current) {
          changes.maxBinStep = rounded;
          rationale.maxBinStep = `All ${winners.length} positions profitable — loosened from ${current} → ${rounded}`;
        }
      }
    }
  }

  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  {
    const buckets = { low: [], medium: [], high: [] };
    for (const p of perfData) {
      if (!isFiniteNum(p.volatility) || !isFiniteNum(p.minutes_held)) continue;
      const bucket = p.volatility < 3 ? "low" : p.volatility < 7 ? "medium" : "high";
      buckets[bucket].push(p);
    }

    for (const [bucketKey, positions] of Object.entries(buckets)) {
      if (positions.length < 3) continue;
      const bWinners = positions.filter(p => p.pnl_pct > 0);
      const bLosers = positions.filter(p => p.pnl_pct < -5);
      const loserWinRate = positions.length > 0
        ? bWinners.length / positions.length
        : 0;

      if (bWinners.length > 0 && bLosers.length > 0) {
        const avgWinHold = avg(bWinners.map(p => p.minutes_held));
        const avgLossHold = avg(bLosers.map(p => p.minutes_held));

        if (avgLossHold > avgWinHold * 1.5) {
          rationale[`hold_${bucketKey}`] = `${bucketKey}-vol: winners held ~${Math.round(avgWinHold)}m vs losers ~${Math.round(avgLossHold)}m — holding losers too long`;
        }
      }

      // Produce actual config changes when a volatility bucket performs poorly
      if (loserWinRate < 0.3 && !changes.maxBinStep) {
        const newVal = Math.max(60, config.screening.maxBinStep - 10);
        if (newVal < config.screening.maxBinStep) {
          changes.maxBinStep = newVal;
          rationale[`vol_${bucketKey}_binstep`] = `${bucketKey}-vol bucket win rate only ${Math.round(loserWinRate * 100)}% (${bWinners.length}/${positions.length}) — tightened maxBinStep from ${config.screening.maxBinStep} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale };

  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  writeFileAtomic.sync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  const s = config.screening;
  if (changes.maxBinStep           != null) s.maxBinStep         = changes.maxBinStep;
  if (changes.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic           != null) s.minOrganic         = changes.minOrganic;

  const db = getDB();
  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, pinned, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    JSON.stringify(["evolution", "config_change"]),
    "evolution",
    0,
    null,
    new Date().toISOString()
  );

  return { changes, rationale };
}

export function getStrategyStats() {
  const db = getDB();
  const perf = db.prepare('SELECT pnl_pct, range_efficiency, strategy FROM performance').all();
  const byStrategy = {};

  for (const p of perf) {
    const key = p.strategy || "unknown";
    if (!byStrategy[key]) {
      byStrategy[key] = { wins: 0, losses: 0, total_pnl: 0, total_range_eff: 0, count: 0 };
    }
    const s = byStrategy[key];
    s.count++;
    if (p.pnl_pct > 0) s.wins++; else s.losses++;
    s.total_pnl += p.pnl_pct;
    s.total_range_eff += p.range_efficiency;
  }

  return Object.fromEntries(
    Object.entries(byStrategy).map(([strat, s]) => [strat, {
      win_rate: Math.round((s.wins / s.count) * 100),
      avg_pnl: Math.round((s.total_pnl / s.count) * 100) / 100,
      avg_range_efficiency: Math.round((s.total_range_eff / s.count) * 10) / 10,
      sample_size: s.count,
    }])
  );
}

function isFiniteNum(n) { return typeof n === "number" && isFinite(n); }
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const db = getDB();
  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, pinned, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), rule, JSON.stringify(tags), "manual", pinned ? 1 : 0, role || null, new Date().toISOString());
  log("info", "lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`);
}

export function pinLesson(id) {
  const db = getDB();
  const res = db.prepare('UPDATE lessons SET pinned = 1 WHERE id = ?').run(id);
  if (res.changes === 0) return { found: false };
  const l = db.prepare('SELECT rule FROM lessons WHERE id = ?').get(id);
  log("info", "lessons", `Pinned lesson ${id}: ${l.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: l.rule };
}

export function unpinLesson(id) {
  const db = getDB();
  const res = db.prepare('UPDATE lessons SET pinned = 0 WHERE id = ?').run(id);
  if (res.changes === 0) return { found: false };
  const l = db.prepare('SELECT rule FROM lessons WHERE id = ?').get(id);
  return { found: true, pinned: false, id, rule: l.rule };
}

export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const db = getDB();
  let query = 'SELECT * FROM lessons';
  const binds = [];
  const clauses = [];

  if (pinned !== null) { clauses.push('pinned = ?'); binds.push(pinned ? 1 : 0); }
  if (role) { clauses.push('(role IS NULL OR role = ?)'); binds.push(role); }

  if (clauses.length > 0) query += ' WHERE ' + clauses.join(' AND ');

  const list = db.prepare(query).all(...binds);
  let lessons = list.map(l => {
    let parsedTags = [];
    try {
      parsedTags = JSON.parse(l.tags || '[]');
      if (typeof parsedTags === "string") parsedTags = JSON.parse(parsedTags);
      if (!Array.isArray(parsedTags)) parsedTags = [];
    } catch (e) { parsedTags = []; }
    return { ...l, tags: parsedTags };
  });
  if (tag) lessons = lessons.filter(l => l.tags.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: l.pinned === 1,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

export function removeLesson(id) {
  const db = getDB();
  return db.prepare('DELETE FROM lessons WHERE id = ?').run(id).changes;
}

export function removeLessonsByKeyword(keyword) {
  const db = getDB();
  const kw = `%${keyword}%`;
  return db.prepare('DELETE FROM lessons WHERE rule LIKE ?').run(kw).changes;
}

export function clearAllLessons() {
  const db = getDB();
  return db.prepare('DELETE FROM lessons').run().changes;
}

export function clearPerformance() {
  const db = getDB();
  return db.prepare('DELETE FROM performance').run().changes;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], 
};

// ─── Lesson Decay: Age-Weighted Selection ───────────────────────

function ageWeight(createdAt) {
  if (!createdAt) return 0.2;
  const days = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 7)   return 1.0;
  if (days <= 30)  return 0.7;
  if (days <= 90)  return 0.4;
  return 0.2;
}

export { ageWeight }; // exported for testing

// ─── Lesson Rating ──────────────────────────────────────────────

export function rateLesson(id, rating) {
  const db = getDB();
  if (!['useful', 'useless'].includes(rating)) return { error: "Rating must be 'useful' or 'useless'" };
  const res = db.prepare(
    "UPDATE lessons SET rating = ?, rating_at = ? WHERE id = ?"
  ).run(rating, new Date().toISOString(), id);
  if (res.changes === 0) return { found: false };
  const l = db.prepare('SELECT rule FROM lessons WHERE id = ?').get(id);
  log("info", "lessons", `Lesson ${id} rated: ${rating}`);
  return { found: true, id, rating, rule: l.rule };
}

export function pinLessonById(id) {
  return pinLesson(id);
}

export function unpinLessonById(id) {
  return unpinLesson(id);
}

export function getLessonsForPrompt(opts = {}) {
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const db = getDB();
  const allRows = db.prepare('SELECT * FROM lessons').all();
  if (allRows.length === 0) return null;

  const allLessons = allRows.map(l => {
    let parsedTags = [];
    try {
      parsedTags = JSON.parse(l.tags || '[]');
      if (typeof parsedTags === "string") parsedTags = JSON.parse(parsedTags);
      if (!Array.isArray(parsedTags)) parsedTags = [];
    } catch (e) { parsedTags = []; }

    return {
      ...l,
      tags: parsedTags,
      pinned: l.pinned === 1,
      _ageWeight: ageWeight(l.created_at),
      _ratedScore: l.rating === 'useful' ? 1.2 : l.rating === 'useless' ? 0.4 : 1.0,
    };
  });

  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  const pinned = allLessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = allLessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    // Sort by priority * age_weight * rated_score (higher = more relevant)
    .sort((a, b) => {
      const scoreA = (outcomePriority[a.outcome] ?? 3) * a._ageWeight * a._ratedScore;
      const scoreB = (outcomePriority[b.outcome] ?? 3) * b._ageWeight * b._ratedScore;
      return scoreA - scoreB;
    })
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? allLessons
        .filter((l) => !usedIds.has(l.id))
        // Sort by age-weighted recency: newest that are still fresh
        .sort((a, b) => {
          const aDays = a.created_at ? (Date.now() - new Date(a.created_at).getTime()) / 86400000 : 999;
          const bDays = b.created_at ? (Date.now() - new Date(b.created_at).getTime()) / 86400000 : 999;
          return aDays - bDays;  // newer first (lower days = higher priority)
        })
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
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

// ─── Learning System Stats ──────────────────────────────────────

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

  // Load current config for evolved thresholds (best effort)
  const thresholds = {};
  try {
    // Try synchronous access via process-level cache or return empty
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

async function asyncRequireConfig() {
  try {
    return await import("../config.js");
  } catch {
    return { config: { screening: {} } };
  }
}

// ─── Performance Data Pruning ───────────────────────────────────

const PERFORMANCE_ARCHIVE_THRESHOLD = 200;
const PERFORMANCE_KEEP = 100;
const NEAR_MISS_MAX_DAYS = 90;

export function prunePerformance() {
  const db = getDB();
  const count = db.prepare('SELECT COUNT(*) as c FROM performance').get().c;
  if (count <= PERFORMANCE_ARCHIVE_THRESHOLD) return { archived: 0, reason: "below threshold" };

  // Get oldest 100 records to archive (count - KEEP oldest go to archive)
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
