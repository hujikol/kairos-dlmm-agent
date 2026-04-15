import { config } from "../config.js";
import {
  MIN_DAILY_ROI,
  IL_RISK_HIGH, IL_RISK_MED, IL_RISK_LOW,
  VOL_BREAK_HIGH, VOL_BREAK_MED,
  CONF_BASELINE, CONF_AGE_48H, CONF_AGE_12H, CONF_LOW_VOL, CONF_FEE_TVL_RATIO,
  RISK_NO_AGE, RISK_HIGH_VOL, RISK_HIGH_RISK, RISK_BUNDLE_30, RISK_LOW_ORGANIC,
  GAS_COST_PER_TX_SOL,
} from "./constants.js";

export function simulatePoolDeploy(pool, deployAmountSol, solPriceUsd) {
  const { volume_24h, fee_pct, active_tvl, volatility, age_hours } = pool;

  // Expected daily fees: volume x fee_tier x your_liquidity_share
  const liquidityShare = (deployAmountSol * solPriceUsd) / (active_tvl || 1);
  const dailyFees = volume_24h * (fee_pct / 100) * liquidityShare;

  // IL risk model: based on volatility and bin range
  const ilRisk = volatility > VOL_BREAK_HIGH ? IL_RISK_HIGH : volatility > VOL_BREAK_MED ? IL_RISK_MED : IL_RISK_LOW;
  const expectedIL = deployAmountSol * solPriceUsd * ilRisk;

  // Gas cost estimate
  const gasCost = GAS_COST_PER_TX_SOL * solPriceUsd;

  const netDaily = dailyFees - expectedIL / 365 - gasCost;
  const minRequired = deployAmountSol * solPriceUsd * MIN_DAILY_ROI / 365;

  // Risk score 0-100
  let riskScore = 0;
  if (!age_hours || age_hours < 12) riskScore += RISK_NO_AGE;
  if (volatility > VOL_BREAK_HIGH) riskScore += RISK_HIGH_VOL;
  if (pool.risk_level === "high") riskScore += RISK_HIGH_RISK;
  if (pool.bundle_pct > 30) riskScore += RISK_BUNDLE_30;
  if (pool.organic_score < 60) riskScore += RISK_LOW_ORGANIC;

  // Confidence 0-100
  let confidence = CONF_BASELINE;
  if (age_hours >= 48) confidence = Math.min(100, confidence + CONF_AGE_48H);
  else if (age_hours >= 12) confidence = Math.min(100, confidence + CONF_AGE_12H);
  if (volatility < VOL_BREAK_MED) confidence += CONF_LOW_VOL;
  if (pool.fee_active_tvl_ratio >= 0.1) confidence += CONF_FEE_TVL_RATIO;

  return {
    daily_fees_usd: Math.round(dailyFees * 100) / 100,
    expected_il_usd: Math.round(expectedIL / 365 * 100) / 100,
    net_daily_usd: Math.round(netDaily * 100) / 100,
    risk_score: Math.min(100, riskScore),
    confidence: Math.min(100, Math.max(0, confidence)),
    passes: netDaily >= minRequired && riskScore <= 40 && confidence >= 40,
  };
}

