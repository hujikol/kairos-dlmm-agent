/**
 * Pool Indicators — fetches pool price data and computes technical indicators.
 * Falls back gracefully if price data is unavailable.
 */

import { log } from "./logger.js";
import { computeRSI, computeBollingerBands, computeSupertrend, computeFibonacciRetracement } from "../tools/chart-indicators.js";

const JUPITER_DATAPI_BASE = process.env.JUPITER_DATAPI_BASE_URL || "https://datapi.jup.ag/v1";

/**
 * Fetch recent price history for a mint from Jupiter.
 * Returns { highs, lows, closes } arrays suitable for indicator calculation.
 * Falls back to empty arrays on failure.
 */
async function fetchPriceHistory(mint) {
  try {
    // Try Jupiter's OHLCV endpoint for price history
    const url = `${JUPITER_DATAPI_BASE}/price/${mint}?period=1h`;
    const res = await fetch(url);

    if (!res.ok) {
      // Try alternative: fetch recent swaps to construct approximate price series
      return fetchPriceFromSwaps(mint);
    }

    const data = await res.json();

    // Check if we got OHLCV data
    if (data.ohlcv && Array.isArray(data.ohlcv) && data.ohlcv.length > 0) {
      const highs = data.ohlcv.map((c) => c.h);
      const lows = data.ohlcv.map((c) => c.l);
      const closes = data.ohlcv.map((c) => c.c);
      return { highs, lows, closes };
    }

    // If no OHLCV data, try to construct from price history array
    if (data.prices && Array.isArray(data.prices) && data.prices.length > 0) {
      const closes = data.prices.map((p) => p.price ?? p.c ?? p.close ?? p);
      // Construct approximate highs/lows using volatility
      const { highs, lows } = approximateHighLow(closes);
      return { highs, lows, closes };
    }

    // Fallback: try swap-based price construction
    return fetchPriceFromSwaps(mint);
  } catch (err) {
    log("warn", "indicators", `Price history fetch failed for ${mint}: ${err.message}`);
    return fetchPriceFromSwaps(mint);
  }
}

/**
 * Fetch approximate price series from recent swaps.
 * Uses Jupiter swap API to get recent transactions and extract prices.
 */
async function fetchPriceFromSwaps(mint) {
  try {
    // Try to get recent swaps from Jupiter
    const url = `${JUPITER_DATAPI_BASE}/swap?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&limit=50`;
    const res = await fetch(url);

    if (!res.ok) {
      return { highs: [], lows: [], closes: [] };
    }

    const data = await res.json();

    // If we got a price from the swap API, use it
    if (data.inAmount && data.outAmount) {
      // This gives us a current price, but not history
      // Return empty to signal no history available
      return { highs: [], lows: [], closes: [] };
    }

    return { highs: [], lows: [], closes: [] };
  } catch {
    return { highs: [], lows: [], closes: [] };
  }
}

/**
 * Approximate highs and lows from a price series using a simple volatility model.
 * This is a fallback when exact OHLCV data is not available.
 */
function approximateHighLow(closes) {
  if (!closes || closes.length === 0) {
    return { highs: [], lows: [] };
  }

  // Calculate average price and standard deviation
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length;
  const stdDev = Math.sqrt(variance);

  // Approximate: high = close + stdDev * 0.5, low = close - stdDev * 0.5
  const highs = closes.map((c) => c + stdDev * 0.5);
  const lows = closes.map((c) => c - stdDev * 0.5);

  return { highs, lows };
}

/**
 * Interpret RSI value for display.
 */
function interpretRSI(rsi) {
  if (rsi === null || rsi === undefined) return "unknown";
  if (rsi >= 70) return "overbought";
  if (rsi <= 30) return "oversold";
  return "neutral (not overbought/oversold)";
}

/**
 * Interpret Bollinger Bands position for display.
 */
function interpretBB(price, bb) {
  if (!bb) return "unknown";
  if (price > bb.upper) return "price above upper band";
  if (price < bb.lower) return "price below lower band";
  if (price > bb.middle) return "price above middle (bullish)";
  return "price below middle (bearish)";
}

/**
 * Fetch pool indicators and compute all technical indicators.
 * @param {Object} opts
 * @param {string} opts.pool_address - Pool address
 * @param {Object} [opts.poolData] - Optional pre-fetched pool data (may contain price, volatility, etc.)
 * @param {string} [opts.mint] - Token mint address
 * @returns {Promise<string>} Formatted indicators string, or empty string on failure
 */
export async function fetchPoolIndicators({ pool_address, poolData = {}, mint }) {
  try {
    const tokenMint = mint || poolData.base?.mint;
    if (!tokenMint) {
      return "";
    }

    // Fetch price history
    let { highs, lows, closes } = await fetchPriceHistory(tokenMint);

    // If no price history, return insufficient data message
    if (closes.length < 5) {
      return "INDICATORS: insufficient price history";
    }

    // Compute indicators
    const rsi = computeRSI(closes, 14);
    const bb = computeBollingerBands(closes, 20, 2);
    const supertrend = computeSupertrend(highs, lows, closes, 10, 3);
    const fib = computeFibonacciRetracement(closes);

    const currentPrice = closes[closes.length - 1];

    // Build formatted output
    const poolName = poolData.name || pool_address?.slice(0, 8) + "..." || "Unknown";

    const parts = [];

    // RSI
    if (rsi !== null) {
      parts.push(`RSI(14): ${rsi.toFixed(1)} — ${interpretRSI(rsi)}`);
    }

    // Bollinger Bands
    if (bb) {
      const bbDesc = `BB(20): upper=${bb.upper.toFixed(4)}, middle=${bb.middle.toFixed(4)}, lower=${bb.lower.toFixed(4)} — ${interpretBB(currentPrice, bb)}`;
      parts.push(bbDesc);
    }

    // Supertrend
    if (supertrend) {
      parts.push(`Supertrend: ${supertrend.direction} (${supertrend.direction === "BUY" ? "bullish trend confirmed" : "bearish trend confirmed"})`);
    }

    // Fibonacci
    if (fib) {
      parts.push(`Fibonacci: 61.8% retracement at ${fib.level61_8?.toFixed(4) ?? "N/A"}`);
    }

    if (parts.length === 0) {
      return "";
    }

    return `INDICATORS: ${poolName}\n  ${parts.join("\n  ")}`;
  } catch (err) {
    log("warn", "indicators", `Failed to compute indicators for ${pool_address}: ${err.message}`);
    return "";
  }
}
