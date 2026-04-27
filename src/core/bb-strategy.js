import { computeBollingerBands } from "../tools/chart-indicators.js";
import { getCandles as gmgnGetCandles } from "../integrations/gmgn.js";

/**
 * Get candles from GMGN and compute Bollinger Bands.
 * Returns null if GMGN not configured or insufficient data.
 * @param {string} mint - Token mint address
 * @param {string} interval - Candle interval (e.g., "1h", "5m", "1d")
 * @param {number} period - Bollinger period (default 20)
 * @param {number} stdDev - Standard deviation multiplier (default 2.0)
 * @returns {Promise<{bb: {upper: number, middle: number, lower: number}, candles: number[]}|null>}
 */
export async function computeBBFromGMGN(mint, interval, period = 20, stdDev = 2.0) {
  const candles = await gmgnGetCandles(mint, interval);
  if (!candles || candles.length < period) return null;

  const closes = candles.map(c => typeof c.close === "number" ? c.close : c.closePrice ?? c.price ?? 0);
  if (closes.length < period) return null;

  const bb = computeBollingerBands(closes, period, stdDev);
  return { bb, closes };
}

/**
 * Detect Bollinger Band crossover events.
 * @param {number} currentPrice - Current price
 * @param {{upper: number, middle: number, lower: number}} currentBB - Current Bollinger Bands
 * @param {{upper: number, middle: number, lower: number}|null} prevBB - Previous Bollinger Bands (null if unavailable)
 * @param {"long"|"short"} positionSide - Position direction
 * @returns {{ signal: null|"oversold_bounce"|"overbought_rejection"|"band_hit", priceAtCross: number|null }}
 */
export function detectBBCross(currentPrice, currentBB, prevBB, positionSide) {
  if (!currentBB) {
    return { signal: null, priceAtCross: null };
  }

  const { upper, lower } = currentBB;

  // Long position signals
  if (positionSide === "long") {
    // Oversold bounce: price crosses above lower band from below
    // (was below prev lower band, now at or above current lower band)
    if (prevBB && prevBB.lower != null) {
      if (currentPrice >= lower && prevBB.lower > currentPrice) {
        return { signal: "oversold_bounce", priceAtCross: lower };
      }
    }

    // Band hit: price at or below lower band
    if (currentPrice <= lower) {
      return { signal: "band_hit", priceAtCross: lower };
    }
  }

  // Short position signals
  if (positionSide === "short") {
    // Overbought rejection: price crosses below upper band from above
    // (was above prev upper band, now at or below current upper band)
    if (prevBB && prevBB.upper != null) {
      if (currentPrice <= upper && prevBB.upper > currentPrice) {
        return { signal: "overbought_rejection", priceAtCross: upper };
      }
    }

    // Band hit: price at or above upper band
    if (currentPrice >= upper) {
      return { signal: "band_hit", priceAtCross: upper };
    }
  }

  return { signal: null, priceAtCross: null };
}

/**
 * Main entry point — called each management cycle.
 * @param {Array} positions - open positions with bb_params in signal_snapshot
 * @param {object} config - management config
 * @returns {Promise<Map>} position_address → exit signal object {action, reason}
 */
export async function checkBbExits(positions, _config) {
  const exitMap = new Map();

  for (const pos of positions) {
    // Skip positions without BB params configured
    const bbParams = pos.bb_params || pos.signal_snapshot?.bb_params;
    if (!bbParams) continue;

    const mint = pos.base_mint || pos.mint;
    if (!mint) continue;

    const interval = bbParams.timeframe || "15m";
    const period = bbParams.period || 20;
    const stdDev = bbParams.stdDev || 2.0;

    const result = await computeBBFromGMGN(mint, interval, period, stdDev);
    if (!result) continue;

    const { bb: currentBB, closes } = result;
    const currentPrice = closes[closes.length - 1];
    if (currentPrice == null) continue;

    // Previous BB from prior candle slice
    const prevCloses = closes.slice(0, -1);
    const prevBB = prevCloses.length >= period
      ? computeBollingerBands(prevCloses, period, stdDev)
      : null;

    const positionSide = bbParams.position_side || "long";
    const { signal, priceAtCross } = detectBBCross(currentPrice, currentBB, prevBB, positionSide);

    // Time stop check
    const entryTime = pos.signal_snapshot?.bb?.entry_time;
    const maxHoldMinutes = bbParams.max_hold_minutes ?? 240;
    let timeStopSignal = null;
    if (entryTime && bbParams.enable_time_stop) {
      const elapsedMin = (Date.now() - new Date(entryTime).getTime()) / 60_000;
      if (elapsedMin >= maxHoldMinutes) {
        timeStopSignal = "BB_TIME_STOP";
      }
    }

    if (signal || timeStopSignal) {
      const reason = timeStopSignal
        ? `BB time stop: held ${Math.round((Date.now() - new Date(entryTime).getTime()) / 60000)}min (max ${maxHoldMinutes})`
        : `BB ${signal}: price ${currentPrice.toFixed(6)} at band ${priceAtCross?.toFixed(6)}`;
      exitMap.set(pos.position, {
        action: signal ? "BB_SIGNAL" : "BB_TIME_STOP",
        reason,
      });
    }
  }

  return exitMap;
}
