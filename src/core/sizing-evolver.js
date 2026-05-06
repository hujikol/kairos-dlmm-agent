/**
 * Evolving Conviction Sizing Matrix.
 *
 * Tracks win rate per conviction level from the decision_log.
 * After enough samples, adjusts sizing multipliers up (winners) or down (losers).
 * Multipliers are persisted in the sizing_matrix table alongside the existing
 * signal_weights infrastructure.
 *
 * Evolution rules:
 * - Win rate ≥ 60%  → boost multiplier by 10% (capped at 2.5× base SOL)
 * - Win rate ≤ 35%  → decay multiplier by 10% (floored at 0.25 SOL)
 * - 35% < wr < 60%  → no change
 *
 * The matrix is keyed by conviction level and open-position count (same shape
 * as the static SIZING_MATRIX in config.js).
 */

import { getDB, runTransaction } from "./db.js";
import { log } from "./logger.js";

// ─── Static defaults (same baseline as config.js) ──────────────────────────────

const DEFAULT_MATRIX = {
  very_high: { 0: 1.50, 1: 1.00, other: 1.00 },
  high:      { 0: 1.00, 1: 1.00, other: 1.00 },
  normal:    { any: 0.50 },
};

// Tunables
const DEFAULT_WINDOW_DAYS   = 60;
const DEFAULT_MIN_SAMPLES   = 10;
const DEFAULT_BOOST_FACTOR  = 1.10;
const DEFAULT_DECAY_FACTOR  = 0.90;
const DEFAULT_CAP          = 2.50; // max multiplier (× SOL floor of 0.5 → 1.25 max deploy)
const DEFAULT_FLOOR         = 0.25; // absolute minimum SOL for any conviction level

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Load the evolved sizing matrix from DB, or return defaults if none exist.
 * @returns {{ matrix: Object, last_evolved: string|null, evolve_count: number }}
 */
export function loadSizingMatrix() {
  const db = getDB();
  const row = db.prepare("SELECT * FROM sizing_matrix WHERE id = 1").get();

  if (!row) {
    const initial = { matrix: { ...DEFAULT_MATRIX }, last_evolved: null, evolve_count: 0 };
    saveSizingMatrix(initial);
    log("info", "sizing-evolver", "Initialized sizing matrix in DB");
    return initial;
  }

  return {
    matrix: JSON.parse(row.matrix || JSON.stringify(DEFAULT_MATRIX)),
    last_evolved: row.last_evolved,
    evolve_count: row.evolve_count || 0,
  };
}

function saveSizingMatrix(data) {
  const db = getDB();
  runTransaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO sizing_matrix (id, matrix, last_evolved, evolve_count)
      VALUES (1, ?, ?, ?)
    `).run(JSON.stringify(data.matrix), data.last_evolved, data.evolve_count);
  });
}

/**
 * Load the full decision log with conviction and pnl_usd, filtered to a time window.
 * @param {number} windowDays
 * @returns {Array<{conviction: string, pnl_usd: number}>}
 */
function loadRecentDecisions(windowDays) {
  const db = getDB();
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  return db.prepare(`
    SELECT conviction, pnl_usd
    FROM   decision_log
    WHERE  type = 'close'
      AND  conviction IS NOT NULL
      AND  pnl_usd   IS NOT NULL
      AND  timestamp >= ?
  `).all(cutoff);
}

// ─── Core Evolution ───────────────────────────────────────────────────────────

/**
 * Compute per-conviction win-rate stats from recent closed decisions.
 *
 * @param {Array}  decisions - result of loadRecentDecisions
 * @param {string} conviction - 'very_high' | 'high' | 'normal'
 * @returns {{ wins: number, losses: number, total: number, winRate: number }|null}
 */
function computeStats(decisions, conviction) {
  const records = decisions.filter(d => d.conviction === conviction);
  if (records.length === 0) return null;
  const wins   = records.filter(d => d.pnl_usd > 0).length;
  const losses = records.filter(d => d.pnl_usd <= 0).length;
  return { wins, losses, total: records.length, winRate: wins / records.length };
}

/**
 * Evolve the sizing matrix based on rolling win-rate stats.
 *
 * Called externally (e.g. from darwin-weights.js or a cron job).
 * Reads all closed decisions from the last `windowDays`, computes win rates per
 * conviction level, and nudges multipliers up/down accordingly.
 *
 * @param {Object} cfg - tuning params (windowDays, minSamples, boostFactor, decayFactor)
 * @returns {{ changes: Array, matrix: Object }}
 */
export function evolveSizingMatrix(cfg = {}) {
  const {
    windowDays   = DEFAULT_WINDOW_DAYS,
    minSamples   = DEFAULT_MIN_SAMPLES,
    boostFactor  = DEFAULT_BOOST_FACTOR,
    decayFactor  = DEFAULT_DECAY_FACTOR,
    cap          = DEFAULT_CAP,
    floor        = DEFAULT_FLOOR,
  } = cfg;

  const data     = loadSizingMatrix();
  const matrix   = data.matrix;
  const decisions = loadRecentDecisions(windowDays);

  if (decisions.length === 0) {
    log("info", "sizing-evolver", "No closed decisions in window, skipping evolution");
    return { changes: [], matrix };
  }

  const convictions = ["very_high", "high", "normal"];
  const changes = [];

  for (const level of convictions) {
    const stats = computeStats(decisions, level);
    if (!stats || stats.total < minSamples) continue;

    const { winRate } = stats;
    const current = matrix[level];

    // Determine how to adjust each position-count key in the matrix
    for (const key of Object.keys(current)) {
      const prevVal = current[key];
      let nextVal   = prevVal;

      if (winRate >= 0.60) {
        // Winners — boost
        nextVal = Math.min(prevVal * boostFactor, cap);
      } else if (winRate <= 0.35) {
        // Losers — decay
        nextVal = Math.max(prevVal * decayFactor, floor);
      }

      nextVal = Math.round(nextVal * 100) / 100; // 2 dp

      if (nextVal !== prevVal) {
        const dir = nextVal > prevVal ? "boosted" : "decayed";
        changes.push({
          conviction: level,
          key,
          from: prevVal,
          to: nextVal,
          winRate: Math.round(winRate * 100),
          samples: stats.total,
          action: dir,
        });
        current[key] = nextVal;
      }
    }
  }

  if (changes.length > 0) {
    const now = new Date().toISOString();
    data.matrix = matrix;
    data.last_evolved = now;
    data.evolve_count = (data.evolve_count || 0) + 1;
    saveSizingMatrix(data);

    // Record history
    const db = getDB();
    runTransaction(() => {
      db.prepare(`
        INSERT INTO sizing_matrix_history (timestamp, changes, window_days, total_records, win_rate)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        now,
        JSON.stringify(changes),
        windowDays,
        decisions.length,
        null // overall win rate not computed here
      );

      // Keep last 50 history rows
      db.prepare(`
        DELETE FROM sizing_matrix_history WHERE id NOT IN (
          SELECT id FROM sizing_matrix_history ORDER BY id DESC LIMIT 50
        )
      `).run();
    });

    log("info", "sizing-evolver",
      `Evolved sizing matrix: ${changes.length} change(s) applied (evolve_count=${data.evolve_count})`);
  } else {
    log("info", "sizing-evolver", "No sizing adjustments needed this cycle");
  }

  return { changes, matrix };
}

// ─── Query helpers (for UI / logs) ───────────────────────────────────────────

/**
 * Return a human-readable summary of the current (possibly evolved) matrix,
 * annotated with win rates from the rolling window.
 *
 * @param {number} windowDays
 * @returns {string}
 */
export function getSizingMatrixSummary(windowDays = DEFAULT_WINDOW_DAYS) {
  const { matrix } = loadSizingMatrix();
  const decisions   = loadRecentDecisions(windowDays);
  const lines      = ["Conviction Sizing Matrix (evolved from closed-position history):"];

  for (const level of ["very_high", "high", "normal"]) {
    const stats    = computeStats(decisions, level);
    const wrLabel  = stats
      ? ` | WR=${(stats.winRate * 100).toFixed(0)}% (n=${stats.total})`
      : " | no data";
    lines.push(`  ${String(level).padEnd(12)}${wrLabel}`);
    const row = matrix[level] || {};
    for (const [key, val] of Object.entries(row)) {
      lines.push(`    positions ${key}: ${val} SOL`);
    }
  }

  return lines.join("\n");
}

/**
 * Get the current effective matrix.
 * @returns {Object}
 */
export function getEffectiveMatrix() {
  return loadSizingMatrix().matrix;
}
