/**
 * Chart Indicators — computes technical indicators from pool candlestick/price data.
 * All functions are pure (no side effects) and return null/undefined on insufficient data.
 */

/**
 * Compute Simple Moving Average.
 * @param {number[]} arr
 * @param {number} period
 * @returns {number|null}
 */
function sma(arr, period) {
  if (!arr || arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Compute Standard Deviation.
 * @param {number[]} arr
 * @param {number} period
 * @param {number} [mean]
 * @returns {number|null}
 */
function stdDev(arr, period, mean) {
  if (!arr || arr.length < period) return null;
  const slice = arr.slice(-period);
  const m = mean ?? (slice.reduce((s, v) => s + v, 0) / slice.length);
  const variance = slice.reduce((s, v) => s + Math.pow(v - m, 2), 0) / slice.length;
  return Math.sqrt(variance);
}

/**
 * Compute Average True Range (ATR) — used by Supertrend.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function computeATR(highs, lows, closes, period = 10) {
  if (!highs || !lows || !closes || closes.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < closes.length; i++) {
    const high = highs[i] ?? closes[i];
    const low = lows[i] ?? closes[i];
    const prevClose = closes[i - 1];
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;
  // Use last `period` true ranges for ATR
  const atrSlice = trueRanges.slice(-period);
  return atrSlice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Compute Relative Strength Index (RSI).
 * @param {number[]} prices - Array of closing prices
 * @param {number} [period=14] - RSI period
 * @returns {number|null} RSI value (0-100) or null if insufficient data
 */
export function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // First average from period+1 price changes
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100; // No losses = overbought extreme
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Compute Bollinger Bands.
 * @param {number[]} prices - Array of closing prices
 * @param {number} [period=20] - Moving average period
 * @param {number} [stdDev=2] - Standard deviation multiplier
 * @returns {{ upper: number, middle: number, lower: number }|null}
 */
export function computeBollingerBands(prices, period = 20, mult = 2) {
  if (!prices || prices.length < period) return null;

  const middle = sma(prices, period);
  if (middle === null) return null;

  const sd = stdDev(prices, period, middle);
  if (sd === null) return null;

  return {
    upper: middle + mult * sd,
    middle,
    lower: middle - mult * sd,
  };
}

/**
 * Compute Supertrend indicator.
 * Uses ATR-based bands to determine trend direction.
 * @param {number[]} highs - Array of high prices
 * @param {number[]} lows - Array of low prices
 * @param {number[]} closes - Array of closing prices
 * @param {number} [period=10] - ATR period
 * @param {number} [multiplier=3] - ATR multiplier for bands
 * @returns {{ direction: "BUY" | "SELL", value: number }|null}
 */
export function computeSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
  if (!highs || !lows || !closes || closes.length < period + 1) return null;

  const atr = computeATR(highs, lows, closes, period);
  if (atr === null) return null;

  const currentClose = closes[closes.length - 1];
  const currentHigh = highs[highs.length - 1] ?? currentClose;
  const currentLow = lows[lows.length - 1] ?? currentClose;

  // Calculate Supertrend bands
  const upperBand = currentHigh + multiplier * atr;
  const lowerBand = currentLow - multiplier * atr;

  // Simple trend detection: if close > upper band, bearish; if close < lower band, bullish
  // For a more complete implementation, we'd track prior Supertrend values
  // Here we use a simplified approach based on price vs ATR bands
  const prevClose = closes[closes.length - 2] ?? currentClose;

  // If price closes above the upper band, trend is bearish (SELL)
  // If price closes below the lower band, trend is bullish (BUY)
  let direction;
  if (currentClose > upperBand) {
    direction = "SELL";
  } else if (currentClose < lowerBand) {
    direction = "BUY";
  } else {
    // If within bands, trend continues - use previous direction
    // For a single-point calculation, default to neutral based on price momentum
    direction = currentClose >= prevClose ? "BUY" : "SELL";
  }

  return {
    direction,
    value: currentClose,
  };
}

/**
 * Compute Fibonacci Retracement levels from a price series.
 * Uses the highest high and lowest low to compute key retracement levels.
 * @param {number[]} prices - Array of prices (uses high and low from the range)
 * @returns {{ level23_6: number, level38_2: number, level61_8: number, level100: number, high: number, low: number }|null}
 */
export function computeFibonacciRetracement(prices) {
  if (!prices || prices.length < 2) return null;

  // Find high and low in the price series
  let high = -Infinity;
  let low = Infinity;
  for (const p of prices) {
    if (p > high) high = p;
    if (p < low) low = p;
  }

  if (!isFinite(high) || !isFinite(low) || high === low) return null;

  const range = high - low;
  const fibLevels = [0, 0.236, 0.382, 0.618, 0.786, 1];

  const result = { high, low, level100: high };
  for (const level of fibLevels) {
    const key = `level${(level * 100).toFixed(1).replace(".0", "")}`;
    result[key] = high - range * level;
  }

  return {
    level23_6: result.level236 ?? (high - range * 0.236),
    level38_2: result.level382 ?? (high - range * 0.382),
    level61_8: result.level618 ?? (high - range * 0.618),
    level100: high,
    high,
    low,
  };
}
