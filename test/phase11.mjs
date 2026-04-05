import { describe, test } from "node:test";
import assert from "node:assert";

// ESM: top-level await to load modules
const { simulatePoolDeploy } = await import("../src/core/simulator.js");
const { checkTokenCorrelation } = await import("../src/core/correlation.js");
const { checkDailyCircuitBreaker, getDailyPnL } = await import("../src/core/daily-tracker.js");
const { config } = await import("../src/config.js");

describe("Phase 11: Daily Profit Architecture", () => {

  describe("simulator.js", () => {
    test("simulatePoolDeploy returns expected shape for healthy pool", () => {
      const pool = {
        volume_24h: 50000,
        fee_pct: 20,
        active_tvl: 60000,
        volatility: 2.0,
        age_hours: 48,
        risk_level: "low",
        bundle_pct: 10,
        organic_score: 75,
        fee_active_tvl_ratio: 0.15,
        bin_step: 100,
      };
      const result = simulatePoolDeploy(pool, 0.6, 200);

      assert.ok(result.daily_fees_usd >= 0, "daily_fees_usd should be non-negative");
      assert.ok(result.expected_il_usd >= 0, "expected_il_usd should be non-negative");
      assert.ok("net_daily_usd" in result, "should have net_daily_usd");
      assert.ok("risk_score" in result, "should have risk_score");
      assert.ok("confidence" in result, "should have confidence");
      assert.ok("passes" in result, "should have passes");
      assert.strictEqual(result.passes, true);
    });

    test("high-volatility pool gets high risk score and fails", () => {
      const pool = {
        volume_24h: 10000,
        fee_pct: 1,
        active_tvl: 50000,
        volatility: 4.5,
        age_hours: 6,
        risk_level: "high",
        bundle_pct: 45,
        organic_score: 40,
        fee_active_tvl_ratio: 0.02,
        bin_step: 80,
      };
      const result = simulatePoolDeploy(pool, 0.5, 200);

      assert.ok(result.risk_score > 80, `risk_score should be high, got ${result.risk_score}`);
      assert.strictEqual(result.passes, false);
    });
  });

  describe("correlation.js", () => {
    test("returns exceeds=false for new token", () => {
      const positions = [
        { base_mint: "tokenA" },
        { base_mint: "tokenB" },
      ];
      const result = checkTokenCorrelation(positions, "tokenC");
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.max, 1);
      assert.strictEqual(result.exceeds, false);
    });

    test("returns exceeds=true when position already exists on token", () => {
      const positions = [
        { base_mint: "tokenA" },
        { base_mint: "tokenB" },
      ];
      const result = checkTokenCorrelation(positions, "tokenA");
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.exceeds, true);
    });
  });

  describe("daily-tracker.js", () => {
    test("getDailyPnL returns valid shape or throws SQLITE_ERROR on missing table", () => {
      try {
        const pnl = getDailyPnL();
        assert.ok(typeof pnl.realized === "number");
        assert.ok(typeof pnl.threshold === "number");
        assert.ok(typeof pnl.lossLimit === "number");
      } catch (e) {
        // OK if the DB doesn't have the performance table in test context
        assert.strictEqual(e.code, "SQLITE_ERROR");
      }
    });

    test("checkDailyCircuitBreaker returns valid action", () => {
      try {
        const circuit = checkDailyCircuitBreaker();
        assert.ok(["halt", "preserve", "trade"].includes(circuit.action));
        // trade action doesn't have a reason field
        if (circuit.action !== "trade") {
          assert.ok(typeof circuit.reason === "string");
        }
      } catch (e) {
        // OK if the DB doesn't have the performance table in test context
        assert.strictEqual(e.code, "SQLITE_ERROR");
      }
    });
  });

  describe("config.js new risk keys", () => {
    test("has dailyProfitTarget", () => {
      assert.strictEqual(config.risk.dailyProfitTarget, 2);
    });

    test("has dailyLossLimit", () => {
      assert.strictEqual(config.risk.dailyLossLimit, -5);
    });

    test("has maxPositionsPerToken", () => {
      assert.strictEqual(config.risk.maxPositionsPerToken, 1);
    });
  });
});
