/**
 * Chart Indicators — unit tests for bounce setup and preset confirmation.
 * Run: node --test test/chart-indicators.test.js
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  computeRSI,
  computeBollingerBands,
  computeSupertrend,
  computeFibonacciRetracement,
  checkBounceSetup,
  confirmIndicatorPreset,
} from "../src/tools/chart-indicators.js";

// ─── Helper builders ─────────────────────────────────────────────────────────

function makeIndicators(overrides = {}) {
  return {
    rsi: null,
    bb: null,
    supertrend: null,
    currentPrice: 0.001,
    ...overrides,
  };
}

function fakeBb(upper, middle, lower) {
  return { upper, middle, lower };
}

// ─── BB position is returned inside checkBounceSetup signal ──────────────────

describe("BB position via checkBounceSetup signal", () => {
  it("bbPosition=above_upper when price > upper band", () => {
    const result = checkBounceSetup({
      rsi: 45,
      bb: fakeBb(0.010, 0.008, 0.006),
      supertrend: { direction: "BUY", value: 0.007 },
      currentPrice: 0.015,
    });
    assert.equal(result.signal.bbPosition, "above_upper");
  });

  it("bbPosition=below_lower when price < lower band", () => {
    const result = checkBounceSetup({
      rsi: 45,
      bb: fakeBb(0.010, 0.008, 0.006),
      supertrend: { direction: "BUY", value: 0.007 },
      currentPrice: 0.003,
    });
    assert.equal(result.signal.bbPosition, "below_lower");
  });

  it("bbPosition=upper when price between middle and upper", () => {
    const result = checkBounceSetup({
      rsi: 45,
      bb: fakeBb(0.010, 0.008, 0.006),
      supertrend: { direction: "BUY", value: 0.007 },
      currentPrice: 0.009,
    });
    assert.equal(result.signal.bbPosition, "upper");
  });

  it("bbPosition=lower when price just below lower band but above lower*0.99", () => {
    // For bb=(upper=0.012, middle=0.010, lower=0.010):
    // lower*0.99 = 0.0099. Price 0.0099 >= 0.0099 → "lower" (near-band but below actual lower)
    // This gap only exists because lower=lower*0.99, so we use a contrived lower band
    const result = checkBounceSetup({
      rsi: 45,
      bb: fakeBb(0.012, 0.010, 0.010),
      supertrend: { direction: "BUY", value: 0.010 },
      currentPrice: 0.0099,
    });
    assert.equal(result.signal.bbPosition, "lower");
  });

  it("bbPosition=upper when price >= middle (lower == middle edge case)", () => {
    // When lower==middle, the >= middle condition fires first → "upper"
    const result = checkBounceSetup({
      rsi: 45,
      bb: fakeBb(0.012, 0.010, 0.010),
      supertrend: { direction: "BUY", value: 0.010 },
      currentPrice: 0.010,
    });
    assert.equal(result.signal.bbPosition, "upper");
  });

  it("bbPosition=null when bb is null", () => {
    const result = checkBounceSetup({
      rsi: 45,
      bb: null,
      supertrend: { direction: "BUY", value: 0.007 },
      currentPrice: 0.008,
    });
    assert.equal(result.signal.bbPosition, null);
  });
});

// ─── checkBounceSetup ────────────────────────────────────────────────────────

describe("checkBounceSetup", () => {
  // Note: checkBounceSetup({ rsi, bb, supertrend, currentPrice, options })
  // All bounce rule options live inside the `options:` key of the first argument.

  const baseOpts = {
    rsi: 45,
    bb: fakeBb(0.015, 0.010, 0.005),
    supertrend: { direction: "BUY", value: 0.0095 },
    currentPrice: 0.010,
    options: {},
  };

  it("passes when all bullish signals align", () => {
    const result = checkBounceSetup(baseOpts);
    assert.equal(result.pass, true);
    assert.ok(result.reasons.length >= 0);
    assert.equal(result.signal.supertrendDirection, "BUY");
  });

  it("rejects when supertrend is SELL (requireBullishSupertrend=true)", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      supertrend: { direction: "SELL", value: 0.0095 },
      options: { requireBullishSupertrend: true },
    });
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some(r => r.toLowerCase().includes("supertrend")));
  });

  it("passes when requireBullishSupertrend=false even with SELL supertrend", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      supertrend: { direction: "SELL", value: 0.0095 },
      options: { requireBullishSupertrend: false },
    });
    assert.equal(result.pass, true);
  });

  it("rejects already-at-bottom: RSI < oversold AND price < bb.lower", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      rsi: 30,
      currentPrice: 0.004,
      options: { rejectAlreadyAtBottom: true, oversoldRsi: 35 },
    });
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some(r => r.toLowerCase().includes("bottom") || r.toLowerCase().includes("already")));
  });

  it("passes RSI < oversold but price above bb.lower (not at bottom)", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      rsi: 30,
      currentPrice: 0.007, // above bb.lower = 0.005
      options: { rejectAlreadyAtBottom: true, oversoldRsi: 35 },
    });
    assert.equal(result.pass, true);
  });

  it("rejects when minRsi is set and RSI is below", () => {
    const result = checkBounceSetup({ ...baseOpts, options: { minRsi: 50 } });
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some(r => r.toLowerCase().includes("rsi")));
  });

  it("rejects when maxRsi is set and RSI is above", () => {
    const result = checkBounceSetup({ ...baseOpts, options: { maxRsi: 40 } });
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some(r => r.toLowerCase().includes("rsi")));
  });

  it("passes when price >= supertrend value (requireAboveSupertrend)", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      currentPrice: 0.011,
      supertrend: { direction: "BUY", value: 0.0095 },
      options: { requireAboveSupertrend: true },
    });
    assert.equal(result.pass, true);
  });

  it("rejects when price < supertrend value (requireAboveSupertrend)", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      currentPrice: 0.008,
      supertrend: { direction: "BUY", value: 0.0095 },
      options: { requireAboveSupertrend: true },
    });
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some(r => r.toLowerCase().includes("supertrend")));
  });

  it("rejects when requireBbPosition is set and position doesn't match", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      currentPrice: 0.004,
      options: { requireBbPosition: "middle" },
    });
    assert.equal(result.pass, false);
  });

  it("passes when requireBbPosition matches", () => {
    const result = checkBounceSetup({
      ...baseOpts,
      currentPrice: 0.004,
      options: { requireBbPosition: "below_lower" },
    });
    assert.equal(result.pass, true);
  });

  it("returns null signal fields for missing indicators", () => {
    const result = checkBounceSetup(makeIndicators({ options: {} }));
    assert.equal(result.signal.rsi, null);
    assert.equal(result.signal.bbPosition, null);
    assert.equal(result.signal.supertrendDirection, null);
  });
});

// ─── confirmIndicatorPreset ──────────────────────────────────────────────────

describe("confirmIndicatorPreset", () => {
  const baseIndicators = {
    rsi: 45,
    bb: fakeBb(0.015, 0.010, 0.005),
    supertrend: { direction: "BUY", value: 0.0095, supertrendBreakUp: false, aboveSupertrend: true },
    fib: { level61_8: 0.009, level50: 0.0095, level78_6: 0.0085, high: 0.015, low: 0.005 },
    currentPrice: 0.010,
  };

  it("supertrend_break entry: confirmed when supertrendBreakUp=true", () => {
    const ind = { ...baseIndicators, supertrend: { ...baseIndicators.supertrend, supertrendBreakUp: true } };
    const result = confirmIndicatorPreset({ preset: "supertrend_break", indicators: ind, side: "entry" });
    assert.equal(result.confirmed, true);
  });

  it("supertrend_break entry: confirmed when direction=BUY and price >= supertrendValue", () => {
    const result = confirmIndicatorPreset({ preset: "supertrend_break", indicators: baseIndicators, side: "entry" });
    assert.equal(result.confirmed, true);
  });

  it("supertrend_break entry: rejected when SELL direction and no break-up", () => {
    const ind = { ...baseIndicators, supertrend: { direction: "SELL", value: 0.0095, supertrendBreakUp: false } };
    const result = confirmIndicatorPreset({ preset: "supertrend_break", indicators: ind, side: "entry" });
    assert.equal(result.confirmed, false);
  });

  it("rsi_reversal entry: confirmed when RSI <= oversold", () => {
    const result = confirmIndicatorPreset({
      preset: "rsi_reversal",
      indicators: { ...baseIndicators, rsi: 30 },
      side: "entry",
      oversoldRsi: 35,
    });
    assert.equal(result.confirmed, true);
  });

  it("rsi_reversal exit: confirmed when RSI >= overbought", () => {
    const result = confirmIndicatorPreset({
      preset: "rsi_reversal",
      indicators: { ...baseIndicators, rsi: 70 },
      side: "exit",
      overboughtRsi: 65,
    });
    assert.equal(result.confirmed, true);
  });

  it("bollinger_reversion entry: confirmed when close <= lower band", () => {
    const result = confirmIndicatorPreset({
      preset: "bollinger_reversion", indicators: { ...baseIndicators, currentPrice: 0.004 }, side: "entry"
    });
    assert.equal(result.confirmed, true);
  });

  it("bollinger_reversion exit: confirmed when close >= upper band", () => {
    const result = confirmIndicatorPreset({
      preset: "bollinger_reversion", indicators: { ...baseIndicators, currentPrice: 0.016 }, side: "exit"
    });
    assert.equal(result.confirmed, true);
  });

  it("bb_plus_rsi entry: requires both bb <= lower AND RSI <= oversold", () => {
    // Only BB condition met
    const r1 = confirmIndicatorPreset({
      preset: "bb_plus_rsi", indicators: { ...baseIndicators, rsi: 50, currentPrice: 0.004 }, side: "entry", oversoldRsi: 35
    });
    assert.equal(r1.confirmed, false);

    // Both conditions met
    const r2 = confirmIndicatorPreset({
      preset: "bb_plus_rsi", indicators: { ...baseIndicators, rsi: 30, currentPrice: 0.004 }, side: "entry", oversoldRsi: 35
    });
    assert.equal(r2.confirmed, true);
  });

  it("fibo_reclaim entry: confirmed when price >= fib618 upward", () => {
    const result = confirmIndicatorPreset({
      preset: "fibo_reclaim", indicators: { ...baseIndicators, currentPrice: 0.0091 }, side: "entry"
    });
    assert.equal(result.confirmed, true);
  });

  it("fibo_reject entry: confirmed when price <= fib618 downward", () => {
    const result = confirmIndicatorPreset({
      preset: "fibo_reject", indicators: { ...baseIndicators, currentPrice: 0.0084 }, side: "entry"
    });
    assert.equal(result.confirmed, true);
  });

  it("returns confirmed=false for unknown preset", () => {
    const result = confirmIndicatorPreset({ preset: "unknown_preset", indicators: baseIndicators, side: "entry" });
    assert.equal(result.confirmed, false);
    assert.ok(result.reason.includes("unknown_preset"), `Expected reason to mention 'unknown_preset': ${result.reason}`);
  });

  it("exit side inverts direction for supertrend_break", () => {
    const sellInd = { ...baseIndicators, supertrend: { ...baseIndicators.supertrend, direction: "SELL", supertrendBreakUp: false } };
    const result = confirmIndicatorPreset({ preset: "supertrend_break", indicators: sellInd, side: "exit" });
    assert.equal(result.confirmed, true); // SELL + exit = price going down = confirmed
  });
});

// ─── computeRSI (regression) ─────────────────────────────────────────────────

describe("computeRSI", () => {
  it("returns null for insufficient data", () => {
    assert.equal(computeRSI([1, 2], 14), null);
  });

  it("returns 100 when avgLoss === 0 (no losses)", () => {
    // All increasing prices
    const prices = Array.from({ length: 20 }, (_, i) => 1 + i * 0.01);
    assert.equal(computeRSI(prices, 14), 100);
  });

  it("returns a number between 0 and 100 for valid data", () => {
    const prices = Array.from({ length: 20 }, (_, i) => Math.sin(i) + 2);
    const rsi = computeRSI(prices, 14);
    assert.ok(rsi !== null);
    assert.ok(rsi >= 0 && rsi <= 100);
  });
});

// ─── computeBollingerBands (regression) ──────────────────────────────────────

describe("computeBollingerBands", () => {
  it("returns null for insufficient data", () => {
    assert.equal(computeBollingerBands([1, 2], 20), null);
  });

  it("returns { upper, middle, lower } for sufficient data", () => {
    const prices = Array.from({ length: 25 }, (_, i) => 1 + Math.sin(i) * 0.1);
    const bb = computeBollingerBands(prices, 20, 2);
    assert.ok(bb !== null);
    assert.ok(bb.upper > bb.middle);
    assert.ok(bb.lower < bb.middle);
  });
});

// ─── computeSupertrend (regression) ─────────────────────────────────────────

describe("computeSupertrend", () => {
  it("returns null for insufficient data", () => {
    assert.equal(computeSupertrend([1], [1], [1], 10), null);
  });

  it("returns { direction, value } for sufficient data", () => {
    // Need at least period+1 (11) candles for ATR period=10
    const closes = Array.from({ length: 15 }, (_, i) => 0.010 + i * 0.0005);
    const highs  = closes.map(c => c + 0.001);
    const lows   = closes.map(c => c - 0.001);
    const st = computeSupertrend(highs, lows, closes, 10, 3);
    assert.ok(st !== null);
    assert.ok(st.direction === "BUY" || st.direction === "SELL");
  });
});

// ─── computeFibonacciRetracement (regression + new fields) ─────────────────

describe("computeFibonacciRetracement", () => {
  it("returns null for insufficient data", () => {
    assert.equal(computeFibonacciRetracement([1]), null);
  });

  it("returns all key levels including level50 and level78_6", () => {
    const prices = [0.005, 0.007, 0.009, 0.011, 0.013, 0.015];
    const fib = computeFibonacciRetracement(prices);
    assert.ok(fib !== null);
    assert.ok(fib.high > fib.low);
    assert.ok(fib.level23_6 != null);
    assert.ok(fib.level38_2 != null);
    assert.ok(fib.level50 != null, "level50 should be present");
    assert.ok(fib.level61_8 != null);
    assert.ok(fib.level78_6 != null, "level78_6 should be present");
    assert.ok(fib.level100 != null);
    // 50% level should be mid-point
    assert.ok(Math.abs(fib.level50 - (fib.high - (fib.high - fib.low) * 0.5)) < 0.001);
  });
});
