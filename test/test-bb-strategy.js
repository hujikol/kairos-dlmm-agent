/**
 * Unit tests for BB strategy: detectBBCross()
 *
 * Tests the BB crossover detection logic:
 * - Long position: price crosses above lower band from below → "oversold_bounce"
 * - Short position: price crosses below upper band from above → "overbought_rejection"
 * - Price touches band → "band_hit"
 * - No cross → null signal
 *
 * Run: node --test test/test-bb-strategy.js
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { detectBBCross } from "../src/core/bb-strategy.js";

describe("detectBBCross", () => {

  // Helper to build a minimal BB object
  const bb = (upper, middle, lower) => ({ upper, middle, lower });

  test("oversold_bounce: long position price crosses above lower band from below", () => {
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 96; // price was 93 (< lower), now 96 (>= lower)

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, "oversold_bounce", "Should detect oversold bounce");
    assert.strictEqual(result.priceAtCross, 94);
  });

  test("overbought_rejection: short position price crosses below upper band from above", () => {
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 103; // price was 106 (> upper), now 103 (<= upper)

    const result = detectBBCross(currentPrice, currentBB, prevBB, "short");
    assert.strictEqual(result.signal, "overbought_rejection", "Should detect overbought rejection");
    assert.strictEqual(result.priceAtCross, 104);
  });

  test("band_hit: long position price touches lower band without prior cross", () => {
    const prevBB = null; // no previous BB
    const currentBB = bb(104, 100, 94);
    const currentPrice = 94; // exactly at lower band

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, "band_hit", "Should detect band hit");
    assert.strictEqual(result.priceAtCross, 94);
  });

  test("band_hit: short position price touches upper band without prior cross", () => {
    const prevBB = null;
    const currentBB = bb(104, 100, 94);
    const currentPrice = 104; // exactly at upper band

    const result = detectBBCross(currentPrice, currentBB, prevBB, "short");
    assert.strictEqual(result.signal, "band_hit", "Should detect band hit");
    assert.strictEqual(result.priceAtCross, 104);
  });

  test("no signal: price still below lower band for long position", () => {
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 93; // below lower band, no cross

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, null, "No signal when price below band without cross");
  });

  test("no signal: price still above upper band for short position", () => {
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(104, 100, 94);
    const currentPrice = 106; // above upper band, no cross

    const result = detectBBCross(currentPrice, currentBB, prevBB, "short");
    assert.strictEqual(result.signal, null, "No signal when price above band without cross");
  });

  test("null BB returns null signal", () => {
    const result = detectBBCross(100, null, null, "long");
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.priceAtCross, null);
  });

  test("edge: price equals band boundary without crossing", () => {
    // Price was 95, lower band is 95, price is still 95 (not crossing from below)
    const prevBB = bb(105, 100, 95);
    const currentBB = bb(105, 100, 95);
    const currentPrice = 95;

    const result = detectBBCross(currentPrice, currentBB, prevBB, "long");
    assert.strictEqual(result.signal, null, "No signal when price only touches without crossing");
  });
});