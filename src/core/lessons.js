/**
 * Agent learning system.
 * Backed by SQLite (kairos.db).
 *
 * Extracted modules:
 *   - src/core/threshold-evolver.js   — threshold evolution logic
 *   - src/core/lesson-repo.js          — lesson CRUD operations
 *   - src/core/darwin-weights.js      — Darwinian signal weight recalculation
 *   - src/core/lesson-service.js      — recordPerformance orchestration + stats
 */

import { getDB } from "./db.js";
import { ageWeight, ROLE_TAGS } from "./lesson-repo.js";
import {
  addLesson, pinLesson, unpinLesson, listLessons,
  removeLesson, removeLessonsByKeyword, clearAllLessons, clearPerformance,
  rateLesson, pinLessonById, unpinLessonById,
  getRelevantLessons,
} from "./lesson-repo.js";

// Re-export lesson-repo (callers that import from lessons.js)
export { addLesson, pinLesson, unpinLesson, listLessons, removeLesson, removeLessonsByKeyword, clearAllLessons, clearPerformance, rateLesson, pinLessonById, unpinLessonById, getRelevantLessons, ROLE_TAGS, ageWeight };

// Re-export from lesson-service
export {
  recordPerformance,
  derivLesson,
  prunePerformance,
  pruneNearMisses,
  getLearningStats,
  getPerformanceSummary,
  getPerformanceHistory,
  PERFORMANCE_ARCHIVE_THRESHOLD,
  PERFORMANCE_KEEP,
  NEAR_MISS_MAX_DAYS,
} from "./lesson-service.js";

// Re-export threshold evolver
export { evolveThresholds } from "./threshold-evolver.js";

// ─── Strategy Stats (remains in lessons.js — not extracted) ──────

export async function getStrategyStats() {
  const db = await getDB();
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

// ─── Lessons for Prompt Injection ──────────────────────────────

export async function getLessonsForPrompt(opts = {}) {
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;
  const db = await getDB();
  const allRows = db.prepare('SELECT * FROM lessons').all();
  if (allRows.length === 0) return null;

  const allLessons = allRows.map(l => {
    let parsedTags = [];
    try {
      parsedTags = JSON.parse(l.tags || '[]');
      if (typeof parsedTags === "string") parsedTags = JSON.parse(parsedTags);
      if (!Array.isArray(parsedTags)) parsedTags = [];
    } catch { parsedTags = []; }

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
    const pin  = l.pinned ? "[*] " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}