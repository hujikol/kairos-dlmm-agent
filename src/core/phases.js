export function detectMarketPhase(pool) {
  const priceChange24h = pool.price_change_24h ?? pool.price_change_pct ?? 0;
  const volRatio = (pool.volume_window ?? 0) / (pool.active_tvl ?? 1);
  const volatility = pool.volatility ?? 1;

  if (priceChange24h > 20 && volRatio > 0.1) return 'pump';
  if (priceChange24h > 10 && volRatio > 0.05) return 'runner';
  if (priceChange24h < -15 && volRatio < 0.03) return 'bear';
  if (priceChange24h < -10) return 'pullback';
  if (volatility < 0.02 && volRatio > 0.02 && priceChange24h >= -5 && priceChange24h <= 5) return 'consolidation';
  return 'normal';
}

export const PHASE_CONFIG = {
  pump:       { description: "Price surging >20%, volume high",         preferredStrategies: ["Wide BidAsk", "DAMM v2 Early", "Pump-and-Run"] },
  runner:     { description: "Sustained uptrend, volume strong",        preferredStrategies: ["Wide BidAsk", "Pump-and-Run", "Wait-for-Pump"] },
  pullback:   { description: "Price down >10% from recent",            preferredStrategies: ["Heart Attack", "Wait-for-Pump"] },
  bear:       { description: "Sustained downtrend, low volume",         preferredStrategies: ["Bear Accumulation", "Slowcook", "Wide BidAsk"] },
  consolidation: { description: "Low volatility, stable volume",        preferredStrategies: ["Slowcook", "Tight Range 10%", "Setup Switch"] },
  normal:     { description: "Mixed signals, sideways movement",        preferredStrategies: ["Fibonacci Range", "Slowcook", "Wide BidAsk"] },
};
