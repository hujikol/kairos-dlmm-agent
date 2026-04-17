import { getDB } from "./db.js";
import { config } from "../config.js";

const DAILY_PROFIT_TARGET = config.risk.dailyProfitTarget ?? 2;
const DAILY_LOSS_LIMIT = config.risk.dailyLossLimit ?? -5;

export async function getDailyPnL() {
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

export async function checkDailyCircuitBreaker() {
  const pnl = await getDailyPnL();
  if (pnl.realized >= pnl.threshold) {
    return { action: "preserve", reason: "Daily profit target hit" };
  }
  if (pnl.realized <= pnl.lossLimit) {
    return { action: "halt", reason: "Daily loss limit hit" };
  }
  return { action: "trade", pnl: pnl.realized };
}
