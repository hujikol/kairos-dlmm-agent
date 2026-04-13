/**
 * Study top LPers for a pool and extract behavioural patterns.
 * Used by the /learn command — not called on every cycle.
 */
import { addrShort } from "../tools/addrShort.js";

import { enqueueLPAgent } from '../lpagent-queue.js';

const LPAGENT_API = process.env.LPAGENT_API_BASE || "https://api.lpagent.io/open-api/v1";
const LPAGENT_KEYS = (process.env.LPAGENT_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let _keyIndex = 0;
function nextKey() {
  if (!LPAGENT_KEYS.length) return null;
  const key = LPAGENT_KEYS[_keyIndex % LPAGENT_KEYS.length];
  _keyIndex++;
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch top LPers for a pool, filter to credible performers,
 * and return condensed behaviour patterns for LLM consumption.
 */
export async function studyTopLPers({ pool_address, limit = 4 }) {
  return enqueueLPAgent(() => _studyTopLPersImpl({ pool_address, limit }));
}

async function _studyTopLPersImpl({ pool_address, limit = 4 }) {
  if (!LPAGENT_KEYS.length) {
    return { pool: pool_address, message: "LPAGENT_API_KEY not set in .env — study_top_lpers is disabled.", patterns: [], lpers: [] };
  }

  // ── 1. Top LPers for this pool ──────────────────────────────
  const topRes = await fetch(
    `${LPAGENT_API}/pools/${pool_address}/top-lpers?sort_order=desc&page=1&limit=20`,
    { headers: { "x-api-key": nextKey() } }
  );

  if (!topRes.ok) {
    if (topRes.status === 429) {
      throw new Error(`Rate limit exceeded. Please wait 60 seconds before studying this pool again.`);
    }
    throw new Error(`top-lpers API error: ${topRes.status}`);
  }

  const topData = await topRes.json();
  const all = topData.data || [];

  // Filter to LPers with enough data to be meaningful
  const credible = all.filter(
    (l) => l.total_lp >= 3 && l.win_rate >= 0.6 && l.total_inflow > 1000
  );

  // Sort by ROI descending, take top N
  const top = credible
    .sort((a, b) => b.roi - a.roi)
    .slice(0, limit);

  if (top.length === 0) {
    return {
      pool: pool_address,
      message: "No credible LPers found (need ≥3 positions, ≥60% win rate, ≥$1k inflow).",
      patterns: [],
      historical_samples: [],
    };
  }

  // ── 2. Historical positions for each top LPer ───────────────
  const historicalSamples = [];

  for (const lper of top) {
    const sample = {
      owner: lper.owner,
      owner_short: addrShort(lper.owner) + "...",
      summary: {
        total_positions: lper.total_lp,
        win_rate: Math.round(lper.win_rate * 100) + "%",
        avg_hold_hours: Number(lper.avg_age_hour?.toFixed(2)),
        roi: (lper.roi * 100).toFixed(2) + "%",
        fee_pct_of_capital: (lper.fee_percent * 100).toFixed(2) + "%",
        total_pnl_usd: Math.round(lper.total_pnl),
      },
      positions: [],
    };

    try {
      // Small buffer to avoid race conditions on the 5-req limit
      await sleep(parseInt(process.env.LPAGENT_RATE_LIMIT_BUFFER_MS || "1000")); 

      const histRes = await fetch(
        `${LPAGENT_API}/lp-positions/historical?owner=${lper.owner}&page=1&limit=50`,
        { headers: { "x-api-key": nextKey() } }
      );

      if (!histRes.ok) {
        historicalSamples.push(sample);
        continue;
      }

      const histData = await histRes.json();
      const positions = histData.data || [];

      sample.positions = positions.map((p) => ({
          pool: p.pool,
          pair: p.pairName || `${p.tokenName0}-${p.tokenName1}`,
          hold_hours: p.ageHour != null ? Number(p.ageHour?.toFixed(2)) : null,
          pnl_usd: Math.round(p.pnl?.value || 0),
          pnl_pct: ((p.pnl?.percent || 0) * 100).toFixed(1) + "%",
          fee_usd: Math.round(p.collectedFee || 0),
          in_range_pct: p.inRangePct != null ? Math.round(p.inRangePct * 100) + "%" : null,
          strategy: p.strategy || null,
          closed_reason: p.closeReason || null,
        }));
      historicalSamples.push(sample);
    } catch {
      historicalSamples.push(sample);
    }
  }

  // ── 3. Aggregate patterns ────────────────────────────────────
  const patterns = {
    top_lper_count: top.length,
    avg_hold_hours: avg(top.map((l) => l.avg_age_hour).filter(isNum)),
    avg_win_rate: avg(top.map((l) => l.win_rate).filter(isNum)),
    avg_roi_pct: avg(top.map((l) => l.roi * 100).filter(isNum)),
    avg_fee_pct_of_capital: avg(top.map((l) => l.fee_percent * 100).filter(isNum)),
    best_roi: (Math.max(...top.map((l) => l.roi)) * 100).toFixed(2) + "%",
    // Scalpers (hold < 1h) vs holders (> 4h)
    scalper_count: top.filter((l) => l.avg_age_hour < 1).length,
    holder_count: top.filter((l) => l.avg_age_hour >= 4).length,
  };

  return {
    pool: pool_address,
    patterns,
    lpers: historicalSamples,
  };
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100;
}

function isNum(n) {
  return typeof n === "number" && isFinite(n);
}
