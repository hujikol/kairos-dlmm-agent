import { computeBollingerBands } from "../tools/chart-indicators.js";

// GMGN import stub — will be wired when GMGN module provides getCandles
// import { gmgn } from "../integrations/gmgn.js";

/**
 * Get candles from GMGN and compute Bollinger Bands.
 * Returns null if GMGN not configured or insufficient data.
 * @param {string} mint - Token mint address
 * @param {string} interval - Candle interval (e.g., "1h", "5m", "1d")
 * @param {number} period - Bollinger period (default 20)
 * @param {number} stdDev - Standard deviation multiplier (default 2.0)
 * @returns {Promise<{bb: {upper: number, middle: number, lower: number}, candles: number[]}|null>}
 */
export async function computeBBFromGMGN(_mint, _interval, _period = 20, _stdDev = 2.0) {
  return null; // stub until GMGN module provides getCandles
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
    if (prevBB && prevBB.lower != null) {
      if (currentPrice >= lower && prevBB.lower > currentPrice) {
        return { signal: "oversold_bounce", priceAtCross: lower };
      }
    }

    // Band hit: price touches lower band
    if (currentPrice <= lower) {
      return { signal: "band_hit", priceAtCross: lower };
    }
  }

  // Short position signals
  if (positionSide === "short") {
    // Overbought rejection: price crosses below upper band from above
    if (prevBB && prevBB.upper != null) {
      if (currentPrice <= upper && prevBB.upper < currentPrice) {
        return { signal: "overbought_rejection", priceAtCross: upper };
      }
    }

    // Band hit: price touches upper band
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

    // Skip if no current price available
    const currentPrice = pos.current_price || pos.price;
    if (currentPrice == null) continue;

    // Determine position side from entry direction
    const positionSide = bbParams.position_side || (pos.amount_x > 0 && pos.amount_y === 0 ? "long" : "short");

    // Compute BB if we have price history
    const prices = pos.price_history || [];
    if (prices.length < 20) continue; // Need at least period data points

    const currentBB = computeBollingerBands(prices, bbParams.period || 20, bbParams.stdDev || 2.0);
    const prevPrices = prices.length > 1 ? prices.slice(0, -1) : null;
    const prevBB = prevPrices ? computeBollingerBands(prevPrices, bbParams.period || 20, bbParams.stdDev || 2.0) : null;

    const { signal, priceAtCross } = detectBBCross(currentPrice, currentBB, prevBB, positionSide);

    if (signal) {
      exitMap.set(pos.position, {
        action: "BB_SIGNAL",
        reason: `BB ${signal}: price ${currentPrice.toFixed(6)} at ${signal.replace("_", " ")} (band: ${priceAtCross?.toFixed(6)})`,
      });
    }
  }

  return exitMap;
}
