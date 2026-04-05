import { config } from "../config.js";

const MIN_DAILY_ROI = 0.02; // 2% daily ROI requirement

export function simulatePoolDeploy(pool, deployAmountSol, solPriceUsd) {
  const { volume_24h, fee_pct, active_tvl, volatility, age_hours } = pool;

  // Expected daily fees: volume x fee_tier x your_liquidity_share
  const liquidityShare = (deployAmountSol * solPriceUsd) / (active_tvl || 1);
  const dailyFees = volume_24h * (fee_pct / 100) * liquidityShare;

  // IL risk model: based on volatility and bin range
  const ilRisk = volatility > 3 ? 0.08 : volatility > 1.5 ? 0.04 : 0.02;
  const expectedIL = deployAmountSol * solPriceUsd * ilRisk;

  // Gas cost estimate
  const gasCost = 0.005 * solPriceUsd * 2; // deploy + close

  const netDaily = dailyFees - expectedIL / 365 - gasCost;
  const minRequired = deployAmountSol * solPriceUsd * MIN_DAILY_ROI / 365;

  // Risk score 0-100
  let riskScore = 0;
  if (!age_hours || age_hours < 12) riskScore += 25;
  if (volatility > 3) riskScore += 20;
  if (pool.risk_level === "high") riskScore += 15;
  if (pool.bundle_pct > 30) riskScore += 15;
  if (pool.organic_score < 60) riskScore += 25;

  // Confidence 0-100
  let confidence = 50; // baseline
  if (age_hours >= 48) confidence = Math.min(100, confidence + 30);
  else if (age_hours >= 12) confidence = Math.min(100, confidence + 15);
  if (volatility < 1.5) confidence += 10;
  if (pool.fee_active_tvl_ratio >= 0.1) confidence += 10;

  return {
    daily_fees_usd: Math.round(dailyFees * 100) / 100,
    expected_il_usd: Math.round(expectedIL / 365 * 100) / 100,
    net_daily_usd: Math.round(netDaily * 100) / 100,
    risk_score: Math.min(100, riskScore),
    confidence: Math.min(100, Math.max(0, confidence)),
    passes: netDaily >= minRequired && riskScore <= 40 && confidence >= 40,
  };
}

function estimateBinRangeWidth(pool) {
  const binStep = pool.bin_step || 100;
  const binsBelow = 50; // typical deploy
  const totalBins = binsBelow;
  return totalBins * binStep / 100; // approximate percentage
}
