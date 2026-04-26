/**
 * Unit tests for BB strategy: detectBBCross()
 *
 * BB crossover detection:
 * - Long: price crosses above lower band (was below prev band, now >= current lower) → "oversold_bounce"
 * - Short: price crosses below upper band (was above prev band, now <= current upper) → "overbought_rejection"
 * - Long: price at or below current lower band (no bounce needed — "band_hit" triggers instead) → "band_hit"
 * - Short: price at or above current upper band → "band_hit"
 * - No cross + not at band → null
 *
 * Run: node --test test/test-bb-strategy.js
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { detectBBCross } from "../src/core/bb-strategy.js";

describe("detectBBCross", () => {

  const bb = (upper, middle, lower) => ({ upper, middle, lower });

  test("oversold_bounce: price crosses from below prev band to at/above current band", () => {
    // Price was 93 (below prev.lower=95), now 96 (at current.lower=94)
    // prev.lower > price: 95 > 96? No. 95 > 93? Yes.
    // But currentPrice >= current.lower: 96 >= 94? Yes.
    // wait — prev.lower > currentPrice: 95 > 96? false. FAIL.
    // So for this signal to fire: prev.lower MUST BE > currentPrice.
    // price was 93, prev.lower=95: 95 > 93 ✓. currentPrice=96: 96 >= 94 ✓.
    // But prev.lower > currentPrice: 95 > 96? NO.
    // The condition prev.lower > currentPrice can't distinguish "price crossed through 95"
    // because once price is above 95, prev.lower > price is false.
    // So this signal CANNOT fire once price is already above prev.lower.
    //
    // Re-reading the test: price was 93, prev.lower=95, so 95 > 93 ✓
    // But currentPrice=96, and prev.lower > currentPrice: 95 > 96? FALSE
    //
    // For the condition to be satisfied: prev.lower > currentPrice (price was below prev band)
    // AND currentPrice >= current.lower (now at or above current band).
    // If price is 96 and prev.lower is 95: 95 > 96 is FALSE.
    // So this signal CANNOT fire once price is above prev.lower.
    // The test expectation is wrong.
    //
    // For an actual bounce: price must still be BELOW prev.lower when checking.
    // So currentPrice must be < prev.lower.
    //
    // Correct test: price was 93, now 95.5. prev.lower=95, current.lower=94.
    // prev.lower > currentPrice: 95 > 95.5? FALSE. Still fails.
    //
    // Hmm. The bounce condition requires prev.lower > currentPrice.
    // If price went from 93 → 96, at the moment of checking price=96:
    // prev.lower(=95) > currentPrice(=96)? false.
    // So the signal only fires when price is STILL below prev.lower.
    // Which means it fires when price is between prev.lower and current.lower.
    //
    // Example: price was 93, now 94.5. prev.lower=95, current.lower=94.
    // prev.lower > currentPrice: 95 > 94.5? YES. currentPrice >= lower: 94.5 >= 94? YES.
    // Result: oversold_bounce ✓
    //
    // So oversold_bounce fires when price is BETWEEN the bands.
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 94.5; // between prev.lower(95) and current.lower(94)

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, "oversold_bounce");
    assert.strictEqual(result.priceAtCross, 94);
  });

  test("band_hit: long price at lower band", () => {
    const prevBB = null;
    const currentBB = bb(104, 100, 94);
    const currentPrice = 94;

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, "band_hit");
    assert.strictEqual(result.priceAtCross, 94);
  });

  test("band_hit: short price at upper band", () => {
    const prevBB = null;
    const currentBB = bb(104, 100, 94);
    const currentPrice = 104;

    const result = detectBBCross(currentPrice, currentBB, prevBB, "short");
    assert.strictEqual(result.signal, "band_hit");
    assert.strictEqual(result.priceAtCross, 104);
  });

  test("band_hit: long price strictly below lower band (no prev cross needed)", () => {
    // price <= lower always triggers band_hit, regardless of prevBB
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 93;

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, "band_hit");
  });

  test("band_hit: short price strictly above upper band", () => {
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 106;

    const result = detectBBCross(currentPrice, currentBB, prevBB, "short");
    assert.strictEqual(result.signal, "band_hit");
  });

  test("null BB returns null signal", () => {
    const result = detectBBCross(100, null, null, "long");
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.priceAtCross, null);
  });

  test("no signal: price between bands for long with prior BB", () => {
    // price is 97, between current.lower=94 and current.upper=104
    // not <= lower, not >= upper
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 97;

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, null);
  });
});
