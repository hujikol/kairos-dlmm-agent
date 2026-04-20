/**
 * Post-mortem rule detection logic.
 *
 * Detects three types of patterns from closed position data:
 *   1. AVOID_PATTERN — strategy × bin_step × volatility combos with poor win rate
 *   2. RECURRING_FAILURE — close reason repeating across recent losses
 *   3. AVOID_TIME_WINDOW — UTC hour with poor win rate
 */

import { WIN_RATE_THRESHOLD, FREQUENCY_THRESHOLD } from "../constants.js";

/**
 * Detect losing pattern: same strategy, similar bin_step and volatility.
 * @param {Object} perfRecord
 * @param {Array} allPerformance
 * @returns {Object|null}
 */
export function detectLosingPattern(perfRecord, allPerformance) {
  if (!perfRecord.strategy || !perfRecord.bin_step || !perfRecord.volatility) return null;

  const similar = allPerformance.filter(p =>
    p.strategy === perfRecord.strategy &&
    p.bin_step != null && Math.abs(p.bin_step - perfRecord.bin_step) <= 10 &&
    p.volatility != null && Math.abs(p.volatility - perfRecord.volatility) <= 2.0
  );

  if (similar.length < 3) return null;

  const winRate = similar.filter(p => p.pnl_pct > 0).length / similar.length;
  const avgPnl = similar.reduce((s, p) => s + p.pnl_pct, 0) / similar.length;

  if (winRate < WIN_RATE_THRESHOLD && avgPnl < -3) {
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

/**
 * Detect recurring failure: same close reason across recent losses.
 * @param {Array} allPerformance
 * @returns {Object|null}
 */
export function detectRecurringFailure(allPerformance) {
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
    if (frequency > FREQUENCY_THRESHOLD && count >= 3) {
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

/**
 * Detect time-of-day pattern: poor win rate at a specific UTC hour.
 * @param {Object} perfRecord
 * @param {Array} allPerformance
 * @returns {Object|null}
 */
export function detectTimePattern(perfRecord, allPerformance) {
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

export function normalizeCloseReason(reason) {
  const r = reason.toLowerCase();
  if (r.includes("stop") || r.includes("loss")) return "stop_loss";
  if (r.includes("range") || r.includes("oor")) return "out_of_range";
  if (r.includes("yield") || r.includes("fee")) return "low_yield";
  if (r.includes("trail")) return "trailing_tp";
  if (r.includes("volume")) return "volume_collapse";
  return reason.toLowerCase().replace(/\s+/g, "_").slice(0, 30);
}

export function getRemediationForReason(reason) {
  const map = {
    out_of_range: "Widen bin_range or switch to bid_ask strategy for volatile tokens",
    stop_loss: "Tighten entry criteria — require stronger narrative + smart wallet presence",
    low_yield: "Raise minFeeActiveTvlRatio threshold; wait for fee/TVL confirmation over 15m",
    trailing_tp: "Working as designed — trailing TP is a controlled exit",
    volume_collapse: "Check volume trend (15m vs 5m) before deploying; require sustained volume",
  };
  return map[reason] || "Review deployment criteria for this type of close";
}