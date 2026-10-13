import { SOL_MINT } from "../constants.js";
// Only these entry thresholds can change. Capital and exit limits remain operator-owned.
export const DEFAULT_RULES = Object.freeze({ minOrganic: 60, maxVolatility: 10, minFeeTvl: 0.05 });
const BOUNDS = { minOrganic: [60, 90], maxVolatility: [2, 10], minFeeTvl: [0.05, 1] };

export function validateRules(rules, previous = null) {
  if (!rules || Array.isArray(rules) || typeof rules !== "object" ||
      Object.keys(rules).length !== 3 || Object.keys(rules).some(k => !Object.hasOwn(BOUNDS, k))) {
    throw new Error("Rules must contain exactly minOrganic, maxVolatility, minFeeTvl");
  }
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const value = rules[key];
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    if (previous) {
      const tightening = key === "maxVolatility" ? value <= previous[key] : value >= previous[key];
      if (!tightening || Math.abs(value - previous[key]) > previous[key] * 0.1 + 1e-9) {
        throw new Error(`${key} may only tighten by at most 10% per update`);
      }
    }
  }
  return rules;
}

export function matchesRules(metrics, rules) {
  return Number.isFinite(metrics.organic_score) && metrics.organic_score >= rules.minOrganic &&
    Number.isFinite(metrics.volatility) && metrics.volatility >= 0 && metrics.volatility <= rules.maxVolatility &&
    Number.isFinite(metrics.fee_tvl_ratio) && metrics.fee_tvl_ratio >= rules.minFeeTvl;
}

export function entryGate(candidate, rules) {
  const { pool, simulation: sim, activeBin, memory } = candidate;
  if (!pool?.pool || !pool.base?.mint || pool.quote?.mint !== SOL_MINT || !Number.isInteger(activeBin)) return "missing pool, mint or active bin";
  if (pool.is_rugpull === true || pool.is_wash === true) return "rugpull or wash-trading flag";
  if (!matchesRules({ ...pool, fee_tvl_ratio: pool.daily_fee_tvl_ratio ?? pool.fee_active_tvl_ratio }, rules)) return "entry thresholds failed or missing metrics";
  if (!sim?.passes || !Number.isFinite(sim.net_daily_usd) || sim.net_daily_usd <= 0 ||
      !Number.isFinite(sim.risk_score) || sim.risk_score > 40 || sim.risk_score < 0 ||
      !Number.isFinite(sim.confidence) || sim.confidence < 40 || sim.confidence > 100) return "simulation failed";
  if (memory?.total_deploys >= 3 && (!Number.isFinite(memory.win_rate) || memory.win_rate < 0.5)) return "pool loss history";
  return null;
}

export function volumeGate(candidate, screening) {
  const { pool } = candidate;
  if (screening.minVolume24h > 0 && (!Number.isFinite(pool.volume_24h) || pool.volume_24h < screening.minVolume24h)) return "insufficient 24h volume";
  if (screening.minVolumeTvl24h > 0 && (!Number.isFinite(pool.volume_24h) || !Number.isFinite(pool.active_tvl) ||
      pool.active_tvl <= 0 || pool.volume_24h / pool.active_tvl < screening.minVolumeTvl24h)) return "insufficient volume/TVL turnover";
  return null;
}

export function chooseCandidate(candidates, rules) {
  return candidates.filter(c => !entryGate(c, rules)).sort((a, b) =>
    (b.simulation.daily_fees_usd ?? 0) - (a.simulation.daily_fees_usd ?? 0) ||
    a.simulation.risk_score - b.simulation.risk_score ||
    b.simulation.confidence - a.simulation.confidence ||
    b.simulation.net_daily_usd - a.simulation.net_daily_usd ||
    a.pool.pool.localeCompare(b.pool.pool)
  )[0] ?? null;
}

// shortcut: replay uses closed trades only; require paper-trade counterfactuals before permitting rule relaxation.
export function validateReplay(next, current, rows) {
  validateRules(next, current);
  const usable = rows.filter(r => Number.isFinite(r.pnl_pct) && matchesRules(r, current));
  if (usable.length < 30) throw new Error("Need 30 eligible closed trades for validation");
  const cut = Math.floor(usable.length * 0.7);
  const stats = group => ({ count: group.length,
    mean: group.reduce((n, r) => n + r.pnl_pct, 0) / group.length,
    winRate: group.filter(r => r.pnl_pct > 0).length / group.length });
  return [usable.slice(0, cut), usable.slice(cut)].map(group => {
    const baseline = stats(group);
    const retained = stats(group.filter(r => matchesRules(r, next)));
    if (retained.count < 5 || retained.count < baseline.count * 0.5 ||
        retained.mean <= baseline.mean || retained.winRate < baseline.winRate) {
      throw new Error("Replay must improve mean PnL without reducing win rate; retain >=50% and >=5 trades in each split");
    }
    return { baseline, retained };
  });
}
