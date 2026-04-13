/**
 * Pattern Recognition Engine.
 *
 * Analyzes historical performance and near-miss data to surface:
 *   - Cluster-level win rates (strategy x vol x bin_step)
 *   - Z-score based anomaly detection
 *   - Human-readable insight strings for LLM prompt injection
 */

import { getDB } from "./db.js";

// ─── Cluster Analysis ───────────────────────────────────────────

/**
 * Group positions by (strategy, volatility_bucket, bin_step_range).
 * Compute win rate, avg PnL, avg time-in-range.
 * Identify clusters with < 40% win rate as "avoid" and > 70% as "prefer".
 *
 * @param {Array} perfData - Array of performance records (from db)
 * @returns {Array} Array of cluster objects with stats
 */
export function analyzeClusters(perfData) {
  if (!perfData || perfData.length === 0) {
    // If called without data, load from db
    const db = getDB();
    perfData = db.prepare('SELECT * FROM performance').all();
  }

  const clusters = {};

  for (const p of perfData) {
    const strategy = p.strategy || "unknown";
    const vol = p.volatility;
    if (!isFinite(vol)) continue;
    const volBucket = vol < 2 ? "very_low" : vol < 4 ? "low" : vol < 6 ? "medium" : vol < 8 ? "high" : "very_high";

    const bs = p.bin_step || 0;
    const binRange = bs < 80 ? "low" : bs < 110 ? "medium" : "high";

    const key = `${strategy}__${volBucket}__${binRange}`;

    if (!clusters[key]) {
      clusters[key] = {
        strategy,
        vol_bucket: volBucket,
        bin_step_range: binRange,
        count: 0,
        wins: 0,
        losses: 0,
        neutral: 0,
        total_pnl_pct: 0,
        total_time_in_range: 0,
        pnl_values: [],
      };
    }

    const c = clusters[key];
    c.count++;
    c.total_pnl_pct += p.pnl_pct || 0;
    c.range_efficiency_sum = (c.range_efficiency_sum || 0) + (p.range_efficiency || 0);
    c.pnl_values.push(p.pnl_pct || 0);

    if (p.pnl_pct > 0) c.wins++;
    else if (p.pnl_pct < -5) c.losses++;
    else c.neutral++;
  }

  const results = Object.values(clusters).map(c => {
    const winRate = c.count > 0 ? c.wins / c.count : 0;
    const avgPnl = c.count > 0 ? c.total_pnl_pct / c.count : 0;
    const avgTimeInRange = c.count > 0 ? (c.range_efficiency_sum / c.count) : 0;

    let label = "neutral";
    if (winRate < 0.4) label = "avoid";
    else if (winRate > 0.7) label = "prefer";

    return {
      ...c,
      win_rate: Math.round(winRate * 100) / 100,
      avg_pnl_pct: Math.round(avgPnl * 100) / 100,
      avg_range_efficiency: Math.round(avgTimeInRange * 10) / 10,
      label,
      min_pnl: Math.min(...c.pnl_values),
      max_pnl: Math.max(...c.pnl_values),
    };
  });

  return results.sort((a, b) => b.win_rate - a.win_rate);
}

// ─── Anomaly Detection ──────────────────────────────────────────

/**
 * Z-score based PnL outlier detection.
 * Flag positions deviating > 2 std from cluster average.
 *
 * @param {Array} perfData - Array of performance records
 * @returns {Array} Array of anomaly objects
 */
export function detectAnomalies(perfData) {
  if (!perfData || perfData.length === 0) {
    const db = getDB();
    perfData = db.prepare('SELECT * FROM performance').all();
  }

  const anomalies = [];

  // Group by cluster for proper std computation
  const clusters = {};
  for (const p of perfData) {
    const strategy = p.strategy || "unknown";
    const vol = p.volatility;
    if (!isFinite(vol)) continue;
    const volBucket = vol < 2 ? "very_low" : vol < 4 ? "low" : vol < 6 ? "medium" : vol < 8 ? "high" : "very_high";
    const bs = p.bin_step || 0;
    const binRange = bs < 80 ? "low" : bs < 110 ? "medium" : "high";
    const key = `${strategy}__${volBucket}__${binRange}`;

    if (!clusters[key]) clusters[key] = [];
    clusters[key].push(p);
  }

  for (const [key, records] of Object.entries(clusters)) {
    if (records.length < 3) continue; // need enough data for meaningful std

    const pnlValues = records.map(p => p.pnl_pct || 0);
    const mean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
    const std = Math.sqrt(pnlValues.reduce((s, v) => s + (v - mean) ** 2, 0) / pnlValues.length);
    if (std === 0) continue;

    for (const p of records) {
      const zScore = ((p.pnl_pct || 0) - mean) / std;
      if (Math.abs(zScore) > 2) {
        anomalies.push({
          position: p.position,
          pool_name: p.pool_name,
          strategy: p.strategy,
          pnl_pct: p.pnl_pct,
          cluster_key: key,
          cluster_mean: Math.round(mean * 100) / 100,
          cluster_std: Math.round(std * 100) / 100,
          z_score: Math.round(zScore * 100) / 100,
          direction: zScore > 0 ? "positive_outlier" : "negative_outlier",
        });
      }
    }
  }

  return anomalies.sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score));
}

// ─── Insight Generation ─────────────────────────────────────────

/**
 * Combine cluster analysis with near-miss data into human-readable insights.
 *
 * @param {Array} perfData - performance records (or null to load from db)
 * @param {Array} nearMissData - near_miss records (or null to load from db)
 * @returns {string} Human-readable insight string for LLM prompt injection
 */
export function generateInsights(perfData, nearMissData) {
  if (!perfData) {
    const db = getDB();
    perfData = db.prepare('SELECT * FROM performance').all();
  }
  if (!nearMissData) {
    const db = getDB();
    try {
      nearMissData = db.prepare('SELECT * FROM near_misses').all();
    } catch (e) { log("warn", "patterns", `Failed to read near_misses: ${e?.message}`); nearMissData = []; }
  }

  const clusters = analyzeClusters(perfData).filter(c => c.count >= 3);
  const avoidClusters = clusters.filter(c => c.label === "avoid");
  const preferClusters = clusters.filter(c => c.label === "prefer");

  const lines = [];

  // Avoid patterns
  for (const c of avoidClusters) {
    lines.push(
      `AVOID: ${c.strategy} with ${c.vol_bucket} volatility and ${c.bin_step_range} bin_step — ` +
      `only ${Math.round(c.win_rate * 100)}% win rate (${c.count} positions), avg PnL ${c.avg_pnl_pct.toFixed(2)}%`
    );
  }

  // Prefer patterns
  for (const c of preferClusters) {
    lines.push(
      `PREFER: ${c.strategy} with ${c.vol_bucket} volatility and ${c.bin_step_range} bin_step — ` +
      `${Math.round(c.win_rate * 100)}% win rate (${c.count} positions), avg PnL ${c.avg_pnl_pct.toFixed(2)}%`
    );
  }

  // Near-miss patterns
  if (nearMissData && nearMissData.length > 0) {
    // Group near misses by volatility < 2 AND bin_step > 100
    const nmVolatileHighStep = nearMissData.filter(n =>
      n.volatility < 2 && n.bin_step > 100
    );
    if (nmVolatileHighStep.length >= 3) {
      const avgPnl = nmVolatileHighStep.reduce((s, n) => s + (n.pnl_pct || 0), 0) / nmVolatileHighStep.length;
      lines.push(
        `NOTE: When volatility < 2 AND bin_step > 100, ${nmVolatileHighStep.length} neutral outcomes — ` +
        `avg PnL ${avgPnl.toFixed(2)}%. These positions barely break even.`
      );
    }

    // Near-miss: low range efficiency
    const nmLowEff = nearMissData.filter(n => n.range_efficiency < 40);
    if (nmLowEff.length >= 3) {
      lines.push(
        `NOTE: ${nmLowEff.length} near-miss positions had range efficiency below 40% — ` +
        `consider wider bin ranges or different strategies for better coverage.`
      );
    }
  }

  // Cross-analysis: strategies that perform differently across vol regimes
  if (perfData.length >= 10) {
    const stratByVol = {};
    for (const p of perfData) {
      const strategy = p.strategy || "unknown";
      const vol = p.volatility;
      if (!isFinite(vol)) continue;
      const volBucket = vol < 2 ? "very_low" : vol < 4 ? "low" : vol < 6 ? "medium" : vol < 8 ? "high" : "very_high";
      const key = `${strategy}__${volBucket}`;
      if (!stratByVol[key]) stratByVol[key] = [];
      stratByVol[key].push(p);
    }

    for (const [key, records] of Object.entries(stratByVol)) {
      if (records.length < 3) continue;
      const winRate = records.filter(r => r.pnl_pct > 0).length / records.length;
      const avgPnl = records.reduce((s, r) => s + (r.pnl_pct || 0), 0) / records.length;
      const [strategy, volBucket] = key.split("__");

      if (winRate < 0.3) {
        lines.push(
          `AVOID ${strategy} in ${volBucket} volatility: ${Math.round(winRate * 100)}% win rate, avg PnL ${avgPnl.toFixed(2)}% (${records.length} trades)`
        );
      } else if (winRate > 0.7) {
        lines.push(
          `PREFER ${strategy} in ${volBucket} volatility: ${Math.round(winRate * 100)}% win rate, avg PnL ${avgPnl.toFixed(2)}% (${records.length} trades)`
        );
      }
    }
  }

  if (lines.length === 0) return null;
  return `PATTERN RECOGNITION INSIGHTS:\n${lines.join("\n")}`;
}

// ─── Helpers ────────────────────────────────────────────────────

function isFinite(val) {
  return typeof val === "number" && Number.isFinite(val);
}
