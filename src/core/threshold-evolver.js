/**
 * Threshold evolution — derives screening threshold adjustments from performance data.
 * Self-contained: no imports from lessons.js.
 */

import { getDB } from "./db.js";
import { USER_CONFIG_PATH } from "../config.js";
import writeFileAtomic from "write-file-atomic";
import fs from "fs";
import crypto from "crypto";

const MIN_EVOLVE_POSITIONS = 5;
const MAX_CHANGE_PER_STEP  = 0.20;
const _evolveLock = new Set();

// ─── Helpers ────────────────────────────────────────────────────

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

// ─── Evolver ────────────────────────────────────────────────────

/**
 * Evolve screening thresholds based on performance data.
 * Uses in-process mutex to prevent concurrent calls from racing on config writes.
 * @param {Array<Object>} perfData - Performance records
 * @param {Object} config - Active config object
 * @returns {{ changes: Object, rationale: Object }|null}
 */
export function evolveThresholds(perfData, config) {
  if (_evolveLock.size > 0) return null;
  _evolveLock.add('evolve');
  try {
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
        const loserWinRate = positions.length > 0 ? bWinners.length / positions.length : 0;

        if (bWinners.length > 0 && bLosers.length > 0) {
          const avgWinHold = avg(bWinners.map(p => p.minutes_held));
          const avgLossHold = avg(bLosers.map(p => p.minutes_held));
          if (avgLossHold > avgWinHold * 1.5) {
            rationale[`hold_${bucketKey}`] = `${bucketKey}-vol: winners held ~${Math.round(avgWinHold)}m vs losers ~${Math.round(avgLossHold)}m — holding losers too long`;
          }
        }

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
    for (const [k, v] of Object.entries(changes)) {
      if (v != null && k in s) s[k] = v;
    }

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
  } finally {
    _evolveLock.delete('evolve');
  }
}

export { MIN_EVOLVE_POSITIONS };
