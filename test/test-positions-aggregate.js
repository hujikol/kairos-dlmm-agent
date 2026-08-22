/**
 * Unit tests for total_unclaimed_fees_usd aggregation in getMyPositions().
 * Tests the pure helper sumUnclaimedFeesUsd() plus response wiring via
 * _injectPositionsCache.
 *
 * Run: node --test test/test-positions-aggregate.js
 */

import { test, describe } from "node:test";
import assert from "node:assert";

import {
  sumUnclaimedFeesUsd,
  _injectPositionsCache,
  _resetPositionsCache,
  getMyPositions,
} from "../src/integrations/meteora/positions.js";

describe("sumUnclaimedFeesUsd", () => {
  test("sums multiple positions", () => {
    const positions = [
      { unclaimed_fees_usd: 1.2345 },
      { unclaimed_fees_usd: 2 },
    ];
    assert.strictEqual(sumUnclaimedFeesUsd(positions), 3.23);
  });

  test("treats null and missing as 0", () => {
    const positions = [
      { unclaimed_fees_usd: null },
      {},
      { unclaimed_fees_usd: 5 },
    ];
    assert.strictEqual(sumUnclaimedFeesUsd(positions), 5);
  });

  test("rounds fractional cents (0.105 + 0.105 => 0.21)", () => {
    const positions = [
      { unclaimed_fees_usd: 0.105 },
      { unclaimed_fees_usd: 0.105 },
    ];
    assert.strictEqual(sumUnclaimedFeesUsd(positions), 0.21);
  });

  test("empty portfolio sums to 0", () => {
    assert.strictEqual(sumUnclaimedFeesUsd([]), 0);
  });
});

describe("getMyPositions wiring", () => {
  test("response exposes total_unclaimed_fees_usd", async () => {
    _resetPositionsCache();
    try {
      _injectPositionsCache({
        wallet: "TestWallet",
        total_positions: 2,
        positions: [
          { position: "Pos1", unclaimed_fees_usd: 10 },
          { position: "Pos2", unclaimed_fees_usd: 2.5 },
        ],
      });
      const result = await getMyPositions();
      assert.strictEqual(result.total_unclaimed_fees_usd, 12.5);
      // Existing fields untouched
      assert.strictEqual(result.wallet, "TestWallet");
      assert.strictEqual(result.total_positions, 2);
      assert.strictEqual(result.positions.length, 2);
    } finally {
      _resetPositionsCache();
    }
  });

  test("empty portfolio response has total_unclaimed_fees_usd of 0", async () => {
    _resetPositionsCache();
    try {
      _injectPositionsCache({
        wallet: "TestWallet",
        total_positions: 0,
        positions: [],
      });
      const result = await getMyPositions();
      assert.strictEqual(result.total_unclaimed_fees_usd, 0);
    } finally {
      _resetPositionsCache();
    }
  });
});
