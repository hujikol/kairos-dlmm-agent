/**
 * Lesson repository — CRUD and retrieval for lessons and near_misses tables.
 * Extracted from lessons.js.
 */

import crypto from "crypto";
import { log } from "./logger.js";
import { getDB } from "./db.js";

// ─── Role Tags ─────────────────────────────────────────────────

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

// ─── Tag Inference ──────────────────────────────────────────────

function inferTags(ctx = {}) {
  const tags = [];
  if (ctx.pair?.includes('SOL')) tags.push('sol_pair');
  if (ctx.tvl > 80_000) tags.push('high_tvl');
  if (ctx.tvl < 20_000) tags.push('low_tvl');
  if (ctx.oor) tags.push('oor');
  if (ctx.pnl_pct < 0) tags.push('losing');
  if (ctx.pnl_pct > 0) tags.push('winning');
  if (ctx.binStep > 100) tags.push('high_volatility');
  if (ctx.binStep < 85) tags.push('low_volatility');
  return tags;
}

// ─── Lesson CRUD ────────────────────────────────────────────────

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

// ─── Lesson Retrieval ────────────────────────────────────────────

/**
 * Tag-ranked lesson retrieval — returns top matching lessons by tags.
 * Falls back to age-weighted global ordering if no tags match.
 */
export function getRelevantLessons(context = {}, limit = 3) {
  const tags = inferTags(context);
  const db = getDB();
  const allRows = db.prepare('SELECT * FROM lessons').all();
  if (allRows.length === 0) return [];

  const parsed = allRows.map(l => {
    let parsedTags = [];
    try { parsedTags = JSON.parse(l.tags || '[]'); } catch (e) { log("warn", "lessons", `Failed to parse tags: ${e?.message}`); parsedTags = []; }
    return { ...l, tags: parsedTags };
  });

  if (tags.length === 0) {
    return parsed
      .sort((a, b) => (b.weight * b.used_count) - (a.weight * a.used_count))
      .slice(0, limit);
  }

  const tagConditions = tags.map(() => `tags LIKE ?`).join(' OR ');
  const rows = db.prepare(`
    SELECT * FROM lessons
    WHERE ${tagConditions}
    ORDER BY weight*used_count DESC
    LIMIT ?
  `).all(...tags.map(t => `%${t}%`), limit);

  const tagged = rows.map(l => {
    let parsedTags = [];
    try { parsedTags = JSON.parse(l.tags || '[]'); } catch (e) { log("warn", "lessons", `Failed to parse tags: ${e?.message}`); parsedTags = []; }
    return { ...l, tags: parsedTags };
  });

  return tagged;
}

// ─── Exports ────────────────────────────────────────────────────

export { ROLE_TAGS, ageWeight, inferTags };
