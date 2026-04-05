// Pre-defined LP Army strategy archetypes from lparmy.com/strategies
export const LPARMY_STRATEGIES = [
  { id: "fibonacci-range", name: "Fibonacci Range", author: "Jajajak.sats", phase: "any", lp_strategy: "spot", best_for: "Technical analysis-driven tokens with clear Fib levels", confidence: 3 },
  { id: "heart-attack", name: "Heart Attack Strategy", author: "molu", phase: "pullback", lp_strategy: "spot", bin_count: 20, best_for: "High-frequency active management on volatile tokens", confidence: 3 },
  { id: "slowcook", name: "Slowcook", author: "mangusxbt", phase: "consolidation", lp_strategy: "spot", bin_count: 50, max_hold_hours: 720, best_for: "Passive fee farming on blue-chip tokens", confidence: 5 },
  { id: "wide-bidask", name: "Wide BidAsk", author: "Michael Zogot", phase: "pump", lp_strategy: "bid_ask", bin_count: 60, fee_tier_target: 0.25, best_for: "Volatile tokens with strong volume", confidence: 4 },
  { id: "damm-early", name: "DAMM v2 Early Entry", author: "Narko", phase: "pump", lp_strategy: "spot", bin_count: 35, best_for: "New pools \u2014 enter early, exit on fee decay", confidence: 3 },
  { id: "wait-for-pump", name: "Wait-for-Pump & Strike", author: "Michael Zogot", phase: "pullback", lp_strategy: "spot", bin_count: 20, best_for: "Deploy AFTER pump confirmation, fast exit", confidence: 4 },
  { id: "tight-range-10", name: "Tight Range 10%", author: "Naoj", phase: "consolidation", lp_strategy: "spot", bin_count: 15, fee_tier_target: 0.10, max_hold_hours: 120, best_for: "Maximum fee capture with fast exit plan", confidence: 5 },
  { id: "bear-accumulation", name: "Bear Market Accumulation", author: "Multiple", phase: "bear", lp_strategy: "bid_ask", bin_count: 40, best_for: "SOL pairs during bear market \u2014 accumulate more SOL", confidence: 4 },
  { id: "pump-and-run", name: "Pump-and-Run", author: "Satsmonkes", phase: "runner", lp_strategy: "spot", bin_count: 25, max_hold_hours: 48, best_for: "Sudden pump tokens \u2014 capture volume fees, exit before dump", confidence: 3 },
  { id: "token-screening", name: "Token Avoidance / Screening", author: "Lochie", phase: "any", lp_strategy: null, best_for: "Pre-deployment sanity check \u2014 verify token has legitimate liquidity", confidence: 6 },
  { id: "setup-switch", name: "Mid-Position Setup Switch", author: "xxq", phase: "consolidation", lp_strategy: "spot", best_for: "High-TVL pool during volatility, rotate to lower-fee when stable", confidence: 3 },
  { id: "overnight-bidask", name: "Overnight Classic Bid Ask", author: "Naoj", phase: "normal", lp_strategy: "bid_ask", bin_count: 80, best_for: "Passive fee collection overnight with wide range protection", confidence: 4 },
];

export function findStrategiesForPhase(phase, limit = 5) {
  return LPARMY_STRATEGIES.filter(s => s.phase === "any" || s.phase === phase).slice(0, limit);
}

export function getStrategyMeta(id) {
  return LPARMY_STRATEGIES.find(s => s.id === id);
}
