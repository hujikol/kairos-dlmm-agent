import { getDB } from "./db.js";
import { config } from "../config.js";

const DAILY_PROFIT_TARGET = config.risk.dailyProfitTarget ?? 2;
const DAILY_LOSS_LIMIT = config.risk.dailyLossLimit ?? -5;
// Unrealized loss circuit breaker: halt if total unrealized loss across open
// positions exceeds unrealizedLossMultiplier × the daily loss limit (e.g. 2.0 × -5% = -10%).
const UNREALIZED_LOSS_MULTIPLIER = config.risk.unrealizedLossMultiplier ?? 2.0;
const UNREALIZED_LOSS_LIMIT = DAILY_LOSS_LIMIT * UNREALIZED_LOSS_MULTIPLIER;

// ─── Test injection ───────────────────────────────────────────────────────────
let _testDailyPnL = null;
let _testCircuitBreaker = null;

/**
 * Inject a mock PnL result for unit tests.
 * Pass null to disable and use real implementation.
 */
export function _injectDailyPnL(result) {
  _testDailyPnL = result;
}

/**
 * Inject a mock circuit breaker result for unit tests.
 * Pass null to disable and use real implementation.
 */
export function _injectCircuitBreaker(result) {
  _testCircuitBreaker = result;
}

export async function getDailyPnL() {
  if (_testDailyPnL !== null) return _testDailyPnL;
  const db = await getDB();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const iso = todayStart.toISOString();

  // Sum realized PnL from closed positions today
  const realized = db.prepare(
    "SELECT COALESCE(SUM(pnl_usd), 0) as total FROM performance WHERE closed_at >= ?",
  ).get(iso).total;

  return { realized, threshold: DAILY_PROFIT_TARGET, lossLimit: DAILY_LOSS_LIMIT };
}

/**
 * Compute total unrealized PnL across all open positions.
 * @param {Array|null} positions - live positions from getMyPositions(), or null to skip
 * @returns {Promise<number>} total unrealized PnL in USD
 */
export async function getUnrealizedPnL(positions) {
  if (!positions || positions.length === 0) return 0;
  const db = await getDB();
  const unrealized = positions.reduce((sum, p) => {
    if (p.closed) return sum;
    const tracked = db.prepare("SELECT pnl_pct FROM positions WHERE position = ?").get(p.position);
    const pnlPct = tracked?.pnl_pct ?? p.pnl_pct ?? 0;
    const valueUsd = p.total_value_usd ?? 0;
    return sum + (valueUsd * pnlPct / 100);
  }, 0);
  return unrealized;
}

export async function checkDailyCircuitBreaker({ positions = null } = {}) {
  if (_testCircuitBreaker !== null) return _testCircuitBreaker;
  const pnl = await getDailyPnL();

  // 1. Daily profit target — preserve wins, skip new deployments
  if (pnl.realized >= pnl.threshold) {
    return { action: "preserve", reason: "Daily profit target hit" };
  }
  // 2. Daily loss limit — halt everything
  if (pnl.realized <= pnl.lossLimit) {
    return { action: "halt", reason: "Daily loss limit hit" };
  }
  // 3. Unrealized loss circuit breaker — halt new deployments if open positions
  // are drawing down hard, even if realized PnL hasn't hit the limit yet.
  if (positions && positions.length > 0) {
    const unrealized = await getUnrealizedPnL(positions);
    const unrealizedLimitUsd = Math.abs(UNREALIZED_LOSS_LIMIT);
    if (unrealized <= UNREALIZED_LOSS_LIMIT) {
      return {
        action: "halt",
        reason: `Unrealized loss circuit breaker: $${unrealized.toFixed(2)} <= $${unrealizedLimitUsd.toFixed(2)} limit`,
        unrealized,
        unrealizedLimit: UNREALIZED_LOSS_LIMIT,
      };
    }
  }
  return { action: "trade", pnl: pnl.realized };
}
