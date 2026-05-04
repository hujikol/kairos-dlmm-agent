import { describe, it } from "node:test";
import assert from "node:assert";
import { computeTokenScore } from "../src/core/token-score.js";

describe("token-score", () => {
  it("computeTokenScore returns score 7 for excellent pool with SOL+stable+high metrics", () => {
    // Pool has USDC as quote_mint — triggers hasSol OR hasStable (both check EPjF)
    const pool = {
      quote_mint: "EPjFWdd5AufqSSqeM2qN7xMQ62TL3NvRCSF2jdqLj5x8", // USDC
      active_tvl: 500000,
      volume_window: 600000,
      organic_score: 80,
      bundle_pct: 20,
      holders: 2000,
    };
    const tokenInfo = { audit: { bot_holders_pct: 5, no_pools: false } };

    const result = computeTokenScore(pool, tokenInfo);

    // hasStable(1) + volume(1) + tvl(1) + holders(1) + noBundle(1) + organic(1) + hasAudit(1) = 7
    assert.strictEqual(result.score, 7);
    assert.strictEqual(result.max, 8);
    assert.strictEqual(result.label, "GOOD — deploy normally");
  });

  it("computeTokenScore returns TRASH for score 0-2", () => {
    const pool = {
      active_tvl: 0,
      volume_window: 0,
      bundle_pct: 80,
    };

    const result = computeTokenScore(pool, null);

    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.label, "TRASH — skip");
  });

  it("computeTokenScore returns OK for score 3-5", () => {
    const pool = {
      quote_mint: "EPjFWdd5AufqSSqeM2qN7xMQ62TL3NvRCSF2jdqLj5x8", // USDC
      active_tvl: 500000,
      volume_window: 0, // no volume
      organic_score: 50,
      bundle_pct: 20,
      holders: 500,
    };

    const result = computeTokenScore(pool, null);

    // hasStable(1) + hasTVL(1) + noBundle(1) = 3
    assert.strictEqual(result.score, 3);
    assert.strictEqual(result.label, "OK — deploy with caution");
  });

  it("computeTokenScore returns EXCELLENT for score 8 with both SOL+USDC signals", () => {
    // quote_mint=EPjF → hasStable; base_mint=So11111 → hasSol
    // Both checks look at all four mint fields, so having them separate satisfies both conditions
    const pool = {
      quote_mint: "EPjFWdd5AufqSSqeM2qN7xMQ62TL3NvRCSF2jdqLj5x8", // USDC → hasStable
      base_mint: "So11111111111111111111111111111111111111112",     // SOL → hasSol
      active_tvl: 500000,
      volume_window: 600000,
      organic_score: 80,
      bundle_pct: 20,
      holders: 2000,
    };
    const tokenInfo = { audit: { bot_holders_pct: 5, no_pools: false } };

    const result = computeTokenScore(pool, tokenInfo);

    // hasSol (base_mint: So11111)(1) + hasStable (quote_mint: EPjF)(1) + volume(1) + tvl(1) + holders(1) + noBundle(1) + organic(1) + hasAudit(1) = 8
    assert.strictEqual(result.score, 8);
    assert.strictEqual(result.max, 8);
    assert.strictEqual(result.label, "EXCELLENT — deploy with conviction");
  });

  it("computeTokenScore handles empty pool gracefully", () => {
    const pool = {};
    const result = computeTokenScore(pool, null);

    assert.ok(result.max === 8);
    assert.ok(result.label.includes("TRASH") || result.label.includes("skip"));
  });
});