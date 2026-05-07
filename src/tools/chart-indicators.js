/**
 * Chart Indicators — computes technical indicators from pool candlestick/price data.
 * All functions are pure (no side effects) and return null/undefined on insufficient data.
 */

import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";

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
  const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  const result = { high, low, level100: high };
  for (const level of fibLevels) {
    const key = `level${(level * 100).toFixed(1).replace(".0", "")}`;
    result[key] = high - range * level;
  }

  return {
    level23_6: result.level236 ?? (high - range * 0.236),
    level38_2: result.level382 ?? (high - range * 0.382),
    level50:   result.level50  ?? (high - range * 0.5),
    level61_8: result.level618 ?? (high - range * 0.618),
    level78_6: result.level786 ?? (high - range * 0.786),
    level100: high,
    high,
    low,
  };
}

// ─── Bounce Setup Confirmation ───────────────────────────────────────────────

/**
 * Compute Bollinger Band position from current price.
 * @param {number} currentPrice
 * @param {{ upper: number, middle: number, lower: number }} bb
 * @returns {"above_upper" | "upper" | "middle" | "lower" | "below_lower"| null}
 */
function computeBbPosition(currentPrice, bb) {
  if (!bb || currentPrice == null) return null;
  if (currentPrice >= bb.upper) return "above_upper";
  if (currentPrice >= bb.middle) return "upper";
  if (currentPrice >= bb.lower) return "middle";
  if (currentPrice >= bb.lower * 0.99) return "lower"; // near lower band
  return "below_lower";
}

/**
 * Check if a bounce setup is valid for DLMM entry.
 * SOL is deployed BELOW current price — token dumps down through bins (collecting fees).
 * Token bounces back up (collecting more fees on the way up).
 * Requires: (1) token NOT already at bottom, (2) bullish trend.
 *
 * @param {Object} opts
 * @param {number|null} opts.rsi - RSI value (0-100)
 * @param {{ upper: number, middle: number, lower: number }|null} opts.bb - Bollinger Bands
 * @param {{ direction: "BUY"|"SELL", value: number }|null} opts.supertrend - Supertrend indicator
 * @param {number} opts.currentPrice - Current token price
 * @param {Object} [opts.options={}] - Bounce rule options
 * @param {boolean} [opts.options.requireBullishSupertrend=true]
 * @param {boolean} [opts.options.rejectAlreadyAtBottom=true]
 * @param {boolean} [opts.options.requireAboveSupertrend=false]
 * @param {number|null} [opts.options.minRsi=null]
 * @param {number|null} [opts.options.maxRsi=null]
 * @param {string|null} [opts.options.requireBbPosition=null] - e.g. "lower" or "middle"
 * @param {number} [opts.options.oversoldRsi=35] - RSI level considered oversold
 * @returns {{ pass: boolean, reasons: string[], signal: Object }}
 */
export function checkBounceSetup({ rsi, bb, supertrend, currentPrice, options = {} }) {
  const {
    requireBullishSupertrend = true,
    rejectAlreadyAtBottom = true,
    requireAboveSupertrend = false,
    minRsi = null,
    maxRsi = null,
    requireBbPosition = null,
    oversoldRsi = 35,
  } = options;

  const reasons = [];
  const signal = {
    rsi: rsi ?? null,
    bbPosition: bb ? computeBbPosition(currentPrice, bb) : null,
    supertrendDirection: supertrend?.direction ?? null,
    supertrendBreakUp: false,
    aboveSupertrend: supertrend ? currentPrice >= supertrend.value : null,
  };

  // Rule: requireBullishSupertrend
  if (requireBullishSupertrend) {
    if (supertrend?.direction !== "BUY") {
      reasons.push("supertrend is not bullish (not BUY)");
    } else {
      signal.supertrendBreakUp = true;
    }
  }

  // Rule: rejectAlreadyAtBottom — RSI < oversold AND price < bb.lower
  if (rejectAlreadyAtBottom && bb) {
    const atBottom = (rsi != null && rsi < oversoldRsi) && currentPrice < bb.lower;
    if (atBottom) {
      reasons.push("already at bottom (RSI oversold + price below BB lower)");
    }
  }

  // Rule: requireAboveSupertrend
  if (requireAboveSupertrend && supertrend) {
    if (currentPrice < supertrend.value) {
      reasons.push("price below supertrend value");
    }
  }

  // Rule: minRsi / maxRsi range check
  if (minRsi != null && rsi != null && rsi < minRsi) {
    reasons.push(`RSI ${rsi.toFixed(1)} below minimum ${minRsi}`);
  }
  if (maxRsi != null && rsi != null && rsi > maxRsi) {
    reasons.push(`RSI ${rsi.toFixed(1)} above maximum ${maxRsi}`);
  }

  // Rule: requireBbPosition
  if (requireBbPosition && signal.bbPosition && signal.bbPosition !== requireBbPosition) {
    reasons.push(`BB position is "${signal.bbPosition}" but required "${requireBbPosition}"`);
  }

  const pass = reasons.length === 0;
  return { pass, reasons, signal };
}

// ─── Indicator Preset Confirmation ───────────────────────────────────────────

/**
 * Confirm whether a given preset matches the current indicator state.
 *
 * @param {Object} opts
 * @param {string} opts.preset - One of: "supertrend_break", "rsi_reversal", "bollinger_reversion",
 *                                "bb_plus_rsi", "fibo_reclaim", "fibo_reject"
 * @param {Object} opts.indicators - Current indicator values
 * @param {string} opts.side - "entry" or "exit"
 * @param {number} [opts.oversoldRsi=35]
 * @param {number} [opts.overboughtRsi=65]
 * @returns {{ confirmed: boolean, reason: string, signal: Object }}
 */
export function confirmIndicatorPreset({ preset, indicators, side, oversoldRsi = 35, overboughtRsi = 65 }) {
  const { rsi, bb, supertrend, fib, currentPrice } = indicators;
  const isEntry = side === "entry";

  const confirmed = false;
  let reason = "unknown preset";
  const signal = {};

  switch (preset) {
    case "supertrend_break": {
      // Supertrend break or bullish confirmation
      if (isEntry) {
        // Entry: confirmed if supertrendBreakUp OR (direction BUY AND price >= supertrendValue)
        const breakUp = supertrend?.direction === "BUY" && currentPrice >= supertrend.value;
        signal.supertrendBreakUp = breakUp;
        if (breakUp) {
          reason = "supertrend break confirmed for entry";
        } else {
          reason = "supertrend not broken for entry";
        }
      } else {
        // Exit: opposite of entry
        const stillBullish = supertrend?.direction === "BUY" && currentPrice >= supertrend.value;
        signal.supertrendBreakUp = stillBullish;
        if (!stillBullish) {
          reason = "supertrend no longer bullish — exit confirmed";
        } else {
          reason = "supertrend still bullish — exit not confirmed";
        }
      }
      return { confirmed: !isEntry ? !signal.supertrendBreakUp : signal.supertrendBreakUp, reason, signal };
    }

    case "rsi_reversal": {
      if (isEntry) {
        const rev = rsi != null && rsi <= oversoldRsi;
        signal.rsiReversal = rev;
        if (rev) {
          reason = `RSI reversal for entry: RSI ${rsi.toFixed(1)} <= ${oversoldRsi}`;
        } else {
          reason = `RSI not at oversold for entry: RSI ${rsi?.toFixed(1) ?? "N/A"} > ${oversoldRsi}`;
        }
        return { confirmed: rev, reason, signal };
      } else {
        const rev = rsi != null && rsi >= overboughtRsi;
        signal.rsiReversal = rev;
        if (rev) {
          reason = `RSI reversal for exit: RSI ${rsi.toFixed(1)} >= ${overboughtRsi}`;
        } else {
          reason = `RSI not at overbought for exit: RSI ${rsi?.toFixed(1) ?? "N/A"} < ${overboughtRsi}`;
        }
        return { confirmed: rev, reason, signal };
      }
    }

    case "bollinger_reversion": {
      if (!bb) return { confirmed: false, reason: "BB not available", signal: {} };
      if (isEntry) {
        const rev = currentPrice <= bb.lower;
        signal.bbReversion = rev;
        if (rev) {
          reason = `Bollinger reversion for entry: price ${currentPrice} <= lower ${bb.lower.toFixed(4)}`;
        } else {
          reason = `Bollinger not at lower band for entry: price ${currentPrice} > lower ${bb.lower.toFixed(4)}`;
        }
        return { confirmed: rev, reason, signal };
      } else {
        const rev = currentPrice >= bb.upper;
        signal.bbReversion = rev;
        if (rev) {
          reason = `Bollinger reversion for exit: price ${currentPrice} >= upper ${bb.upper.toFixed(4)}`;
        } else {
          reason = `Bollinger not at upper band for exit: price ${currentPrice} < upper ${bb.upper.toFixed(4)}`;
        }
        return { confirmed: rev, reason, signal };
      }
    }

    case "bb_plus_rsi": {
      if (!bb) return { confirmed: false, reason: "BB not available", signal: {} };
      if (isEntry) {
        const belowLower = currentPrice <= bb.lower;
        const rsiLow = rsi != null && rsi <= oversoldRsi;
        signal.bbPlusRsi = { belowLower, rsiLow };
        if (belowLower && rsiLow) {
          reason = `BB+RSI for entry: price below lower band AND RSI ${rsi.toFixed(1)} <= ${oversoldRsi}`;
        } else if (belowLower) {
          reason = `BB+RSI partial for entry: price below lower band but RSI ${rsi?.toFixed(1) ?? "N/A"} > ${oversoldRsi}`;
        } else {
          reason = `BB+RSI not confirmed for entry: price ${currentPrice} > lower ${bb.lower.toFixed(4)}`;
        }
        return { confirmed: belowLower && rsiLow, reason, signal };
      } else {
        const aboveUpper = currentPrice >= bb.upper;
        const rsiHigh = rsi != null && rsi >= overboughtRsi;
        signal.bbPlusRsi = { aboveUpper, rsiHigh };
        if (aboveUpper && rsiHigh) {
          reason = `BB+RSI for exit: price above upper band AND RSI ${rsi.toFixed(1)} >= ${overboughtRsi}`;
        } else if (aboveUpper) {
          reason = `BB+RSI partial for exit: price above upper band but RSI ${rsi?.toFixed(1) ?? "N/A"} < ${overboughtRsi}`;
        } else {
          reason = `BB+RSI not confirmed for exit: price ${currentPrice} < upper ${bb.upper.toFixed(4)}`;
        }
        return { confirmed: aboveUpper && rsiHigh, reason, signal };
      }
    }

    case "fibo_reclaim": {
      // Price reclaimed fib618, fib50, or fib786 upward
      if (!fib) return { confirmed: false, reason: "Fib not available", signal: {} };
      const { level61_8, level50, level78_6 } = fib;
      const reclaimed =
        (level61_8 != null && currentPrice >= level61_8) ||
        (level50 != null && currentPrice >= level50) ||
        (level78_6 != null && currentPrice >= level78_6);
      signal.fiboReclaim = { level61_8, level50, level78_6, reclaimed };
      if (reclaimed) {
        reason = `Fibo reclaim for ${isEntry ? "entry" : "exit"}: price reclaimed key fib level`;
      } else {
        reason = `Fibo reclaim not confirmed: price below key fib levels`;
      }
      return { confirmed: reclaimed, reason, signal };
    }

    case "fibo_reject": {
      // Price rejected fib618, fib50, or fib786 downward
      if (!fib) return { confirmed: false, reason: "Fib not available", signal: {} };
      const { level61_8, level50, level78_6 } = fib;
      const rejected =
        (level61_8 != null && currentPrice <= level61_8) ||
        (level50 != null && currentPrice <= level50) ||
        (level78_6 != null && currentPrice <= level78_6);
      signal.fiboReject = { level61_8, level50, level78_6, rejected };
      if (rejected) {
        reason = `Fibo reject for ${isEntry ? "entry" : "exit"}: price rejected key fib level downward`;
      } else {
        reason = `Fibo reject not confirmed: price above key fib levels`;
      }
      return { confirmed: rejected, reason, signal };
    }

    default:
      return { confirmed: false, reason: `Unknown preset: ${preset}`, signal: {} };
  }
}

// ─── Fetch Chart Indicators from Agent Meridian ───────────────────────────────

/**
 * Fetch pre-computed chart indicators for a mint from Agent Meridian API.
 * @param {string} mint - Token mint address
 * @param {Object} opts
 * @param {string} [opts.interval="5m"] - Chart interval
 * @param {number} [opts.candles=100] - Number of candles to fetch
 * @param {number} [opts.rsiLength=14] - RSI period
 * @returns {Promise<Object>} Parsed JSON payload
 * @throws {Error} On non-ok response
 */
export async function fetchChartIndicatorsForMint(mint, { interval = "5m", candles = 100, rsiLength = 14 } = {}) {
  const url = `${getAgentMeridianBase()}/chart-indicators/${mint}?interval=${encodeURIComponent(interval)}&candles=${candles}&rsiLength=${rsiLength}`;
  const res = await fetch(url, {
    headers: getAgentMeridianHeaders(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fetchChartIndicatorsForMint ${res.status}: ${text}`);
  }

  return res.json();
}
