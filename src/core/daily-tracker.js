import { getDB } from "./db.js";
import { getRiskConfig } from "./config-facade.js";

/**
 * Returns risk config values for daily PnL tracking.
 * Called at runtime rather than module-load time to ensure config is validated.
 */
function getDailyLimits() {
  const r = getRiskConfig();
  return {
    DAILY_PROFIT_TARGET: r.dailyProfitTarget ?? 2,
    DAILY_LOSS_LIMIT: r.dailyLossLimit ?? -5,
  };
}

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
  const { DAILY_PROFIT_TARGET, DAILY_LOSS_LIMIT } = getDailyLimits();

  // Sum realized PnL from closed positions today
  const realized = db.prepare(
    "SELECT COALESCE(SUM(pnl_usd), 0) as total FROM performance WHERE closed_at >= ?",
  ).get(iso).total;

  return { realized, threshold: DAILY_PROFIT_TARGET, lossLimit: DAILY_LOSS_LIMIT };
}

export async function checkDailyCircuitBreaker() {
  if (_testCircuitBreaker !== null) return _testCircuitBreaker;
  const pnl = await getDailyPnL();
  if (pnl.realized >= pnl.threshold) {
    return { action: "preserve", reason: "Daily profit target hit" };
  }
  if (pnl.realized <= pnl.lossLimit) {
    return { action: "halt", reason: "Daily loss limit hit" };
  }
  return { action: "trade", pnl: pnl.realized };
}
