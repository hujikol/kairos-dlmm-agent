/**
 * Decision Log — records every significant agent decision to SQLite.
 *
 * Decision types: "deploy" | "close" | "skip" | "claim" | "learn"
 *
 * Auto-prunes:
 *   - On module init if table has >10,000 rows
 *   - Records older than 30 days on every write
 */

import { getDB } from "./db.js";
import { log } from "./logger.js";

const TABLE = "decision_log";
const PRUNE_DAYS = 30;
const AUTO_PRUNE_THRESHOLD = 10_000;

// ─── Table creation (called on module init) ───────────────────────────────────

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT,
      type            TEXT,
      pool_address    TEXT,
      pool_name       TEXT,
      position_address TEXT,
      amount_sol      REAL,
      pnl_usd         REAL,
      pnl_pct         REAL,
      reasoning       TEXT,
      metadata        TEXT,
      initiated_by    TEXT,
      bin_step        REAL,
      volatility      REAL,
      fee_tvl_ratio   REAL,
      organic_score   REAL,
      strategy        TEXT,
      conviction      TEXT CHECK (conviction IN ('very_high','high','normal'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_timestamp ON ${TABLE}(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_type ON ${TABLE}(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_pool ON ${TABLE}(pool_address)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_log_conviction ON ${TABLE}(conviction)`);
}

// ─── Auto-prune helpers ───────────────────────────────────────────────────────

function pruneOldRecords(db) {
  const cutoff = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString();
  const { changes } = db.prepare(
    `DELETE FROM ${TABLE} WHERE timestamp < ?`
  ).run(cutoff);
  if (changes > 0) {
    log("info", "decision-log", `Pruned ${changes} records older than ${PRUNE_DAYS} days`);
  }
  return changes;
}

function pruneIfNeeded(db) {
  const { c } = db.prepare(`SELECT COUNT(*) as c FROM ${TABLE}`).get();
  if (c > AUTO_PRUNE_THRESHOLD) {
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString();
    const toDelete = c - AUTO_PRUNE_THRESHOLD;
    const oldest = db.prepare(
      `SELECT id FROM ${TABLE} ORDER BY timestamp ASC LIMIT ?`
    ).all(toDelete);
    if (oldest.length > 0) {
      const ids = oldest.map(r => r.id);
      db.prepare(`DELETE FROM ${TABLE} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      log("info", "decision-log", `Auto-pruned ${ids.length} oldest records (table had ${c} rows, threshold ${AUTO_PRUNE_THRESHOLD})`);
    }
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

let _initialized = false;

async function init() {
  if (_initialized) return;
  const db = await getDB();
  if (!db) return; // db not ready yet — will init on first recordDecision call
  ensureTable(db);
  pruneIfNeeded(db);
  _initialized = true;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Record a significant agent decision.
 *
 * @param {Object} opts
 * @param {"deploy"|"close"|"skip"|"claim"|"learn"} opts.type
 * @param {string|Object} opts.pool - Pool address string or { address, name }
 * @param {string}         opts.position - Position address
 * @param {number}         opts.amount - SOL amount deployed/closed
 * @param {number|Object}  opts.pnl - PnL in USD, or { usd, pct }
 * @param {string}         opts.reasoning - Human-readable analysis/decision text
 * @param {Object}         [opts.metadata] - Additional context
 * @param {"llm"|"rule"}   [opts.initiatedBy] - What triggered this decision
 */
export async function recordDecision({
  type,
  pool,
  position,
  amount,
  pnl,
  reasoning,
  metadata = {},
  initiatedBy = "llm",
}) {
  const db = await getDB();
  if (!db) {
    log("warn", "decision-log", "DB not ready — skipping decision record");
    return;
  }

  // Lazy init (handles case where module is imported before db is fully ready)
  await init();

  const timestamp = new Date().toISOString();
  const poolAddress = pool != null && typeof pool === "object" ? pool.address : pool;
  const poolName = pool != null && typeof pool === "object" ? pool.name : metadata.pool_name;

  const pnlUsd = pnl != null && typeof pnl === "object" ? pnl.usd : pnl;
  const pnlPct = pnl != null && typeof pnl === "object" ? pnl.pct : null;

  db.prepare(`
    INSERT INTO ${TABLE} (
      timestamp, type, pool_address, pool_name, position_address,
      amount_sol, pnl_usd, pnl_pct, reasoning, metadata,
      initiated_by, bin_step, volatility, fee_tvl_ratio, organic_score, strategy,
      conviction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp,
    type,
    poolAddress || null,
    poolName || null,
    position || null,
    amount ?? null,
    pnlUsd ?? null,
    pnlPct ?? null,
    reasoning || null,
    JSON.stringify(metadata),
    initiatedBy,
    metadata.bin_step ?? null,
    metadata.volatility ?? null,
    metadata.fee_tvl_ratio ?? null,
    metadata.organic_score ?? null,
    metadata.strategy ?? null,
    metadata.conviction ?? null,
  );

  // Prune old records on every write
  try {
    pruneOldRecords(db);
  } catch (e) {
    log("warn", "decision-log", `Prune failed: ${e.message}`);
  }
}

/**
 * Query decision log with optional filters.
 *
 * @param {Object}   opts
 * @param {string}   [opts.pool]    - Filter by pool address
 * @param {number}   [opts.limit]   - Max records (default 100)
 * @param {string}   [opts.type]    - Filter by decision type
 * @param {number}   [opts.hours]   - Only records within last N hours (default 24)
 * @returns {Array} Array of decision records
 */
export async function getDecisions({ pool, limit = 100, type, hours = 24 } = {}) {
  const db = await getDB();
  if (!db) return [];
  await init();

  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  let sql = `SELECT * FROM ${TABLE} WHERE timestamp >= ?`;
  const params = [cutoff];

  if (pool) {
    sql += ` AND pool_address = ?`;
    params.push(pool);
  }
  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Shorten a pool address for display (first 6 + last 4 chars).
 * @param {string} addr
 * @returns {string}
 */
function poolShort(addr) {
  if (!addr || addr.length < 12) return addr ?? "?";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Returns a formatted string of recent decisions for LLM prompt injection.
 * Returns null if no decisions are found.
 *
 * @param {{ limit?: number, hours?: number }} opts
 * @returns {Promise<string|null>}
 */
export async function getDecisionSummary({ limit = 6, hours = 72 } = {}) {
  const decisions = await getDecisions({ limit, hours });
  if (!decisions.length) return null;

  const lines = [`RECENT DECISIONS:`];
  decisions.forEach((d, i) => {
    const actor = (d.initiated_by ?? "rule").toUpperCase();
    const type = d.type?.toUpperCase() ?? "UNKNOWN";
    const name = d.pool_name || poolShort(d.pool_address);

    // Core metrics string
    const metrics = [];
    if (d.pnl_usd != null) metrics.push(`pnl_usd=$${Number(d.pnl_usd).toFixed(2)}`);
    if (d.pnl_pct != null) metrics.push(`pnl_pct=${Number(d.pnl_pct).toFixed(1)}%`);
    if (d.amount_sol != null) metrics.push(`sol=${Number(d.amount_sol).toFixed(3)}`);

    const reason = d.reasoning
      ? d.reasoning.length > 60
        ? d.reasoning.slice(0, 57) + "…"
        : d.reasoning
      : "";

    const parts = [
      `${i + 1}. [${actor}] ${type} ${name}`,
      reason,
      metrics.length ? metrics.join(" ") : null,
    ].filter(Boolean);

    lines.push(parts.join(" — "));
  });

  return lines.join("\n");
}

/**
 * Returns aggregate statistics for decisions within a rolling window.
 *
 * @param {{ hours?: number }} opts
 * @returns {Promise<{ total: number, byType: Object, winRate: number|null, avgPnlPct: number|null }>}
 */
export async function getDecisionStats({ hours = 168 } = {}) {
  const db = await getDB();
  if (!db) {
    return { total: 0, byType: {}, winRate: null, avgPnlPct: null };
  }
  await init();

  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  const rows = db
    .prepare(`SELECT type, pnl_usd, pnl_pct FROM ${TABLE} WHERE timestamp >= ?`)
    .all(cutoff);

  if (!rows.length) {
    return { total: 0, byType: {}, winRate: null, avgPnlPct: null };
  }

  const byType = {};
  let winCount = 0;
  let pnlSum = 0;
  let pnlCount = 0;

  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    if (row.pnl_usd != null) {
      if (Number(row.pnl_usd) > 0) winCount++;
      pnlSum += Number(row.pnl_usd);
      pnlCount++;
    }
  }

  return {
    total: rows.length,
    byType,
    winRate: pnlCount > 0 ? (winCount / pnlCount) * 100 : null,
    avgPnlPct: pnlCount > 0 ? pnlSum / pnlCount : null,
  };
}
