/**
 * Unit tests for src/config.js
 * Uses Node's built-in test runner (node:test).
 *
 * Run: node --test test/test-config.js
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { computeDeployAmount, config } from "../src/config.js";

describe("computeDeployAmount", () => {

  // Note: Actual config values come from user-config.json which overrides defaults.
  // Tests use the runtime config values (gasReserve=0.05, deployAmountSol=0.48, maxDeployAmount=1.44).

  test("returns calculated amount for small wallet", () => {
    // walletSol = 0.5, reserve = 0.05, deployable = 0.45
    // target = 0.35 (normal), ceil = min(1.44, 0.45) = 0.45
    // amount = min(0.45, 0.35) = 0.35
    const result = computeDeployAmount(0.5);
    assert.strictEqual(result.amount, 0.35);
    assert.strictEqual(result.error, null);
  });

  test("returns calculated amount when wallet is large", () => {
    // walletSol = 10, deployable = 9.95, target = 0.35 (normal)
    // ceil = min(1.44, 9.95) = 1.44, amount = min(1.44, 0.35) = 0.35
    const result = computeDeployAmount(10);
    assert.strictEqual(result.amount, 0.35);
    assert.strictEqual(result.error, null);
  });

  test("returns error when wallet has zero SOL", () => {
    const result = computeDeployAmount(0);
    assert.strictEqual(result.amount, 0);
    assert.ok(result.error.includes("Insufficient SOL"));
  });

  test("returns error when wallet is below gas reserve", () => {
    // walletSol = 0.04, reserve = 0.05, deployable = max(0, -0.01) = 0
    const result = computeDeployAmount(0.04);
    assert.strictEqual(result.amount, 0);
    assert.ok(result.error.includes("Insufficient SOL"));
  });

  test("returns error when wallet is just above zero but below 0.1 floor", () => {
    // walletSol = 0.12, reserve = 0.05, deployable = 0.07
    // 0.07 < 0.1 floor → error
    const result = computeDeployAmount(0.12);
    assert.strictEqual(result.amount, 0);
    assert.ok(result.error.includes("Insufficient SOL"));
  });

  test("very_high conviction with 0 positions uses 1.05 target", () => {
    // walletSol = 5, deployable = 4.95, target = 1.05 (very_high, 0 positions)
    const result = computeDeployAmount(5, 0, "very_high");
    assert.strictEqual(result.amount, 1.05);
    assert.strictEqual(result.error, null);
  });

  test("very_high conviction with 1+ positions uses 0.70 target", () => {
    // walletSol = 5, deployable = 4.95, target = 0.70 (very_high, other)
    const result = computeDeployAmount(5, 1, "very_high");
    assert.strictEqual(result.amount, 0.7);
    assert.strictEqual(result.error, null);
  });

  test("high conviction uses 0.53 target", () => {
    const result = computeDeployAmount(5, 0, "high");
    assert.strictEqual(result.amount, 0.53);
    assert.strictEqual(result.error, null);
  });

  test("clamps at maxDeployAmount when deployable exceeds it", () => {
    // walletSol = 100, deployable = 99.95, ceil = min(1.44, 99.95) = 1.44
    // For normal conviction: amount = min(1.44, 0.35) = 0.35
    const result = computeDeployAmount(100);
    assert.strictEqual(result.amount, 0.35);
  });
});

describe("config loads correctly", () => {
  test("config object exists and has required sections", () => {
    assert.ok(config);
    assert.ok(config.screening);
    assert.ok(config.management);
    assert.ok(config.risk);
    assert.ok(config.schedule);
    assert.ok(config.llm);
  });

  test("default screening thresholds are present", () => {
    const s = config.screening;
    assert.ok(typeof s.minFeeActiveTvlRatio === "number");
    assert.ok(typeof s.minTvl === "number");
    assert.ok(typeof s.maxTvl === "number");
    assert.ok(typeof s.minVolume === "number");
    assert.ok(typeof s.minOrganic === "number");
    assert.ok(typeof s.minBinStep === "number");
    assert.ok(typeof s.maxBinStep === "number");
  });

  test("default management settings are present", () => {
    const m = config.management;
    assert.ok(typeof m.stopLossPct === "number");
    assert.ok(typeof m.takeProfitFeePct === "number");
    assert.ok(typeof m.deployAmountSol === "number");
    assert.ok(typeof m.maxDeployAmount === "number");
    assert.ok(typeof m.gasReserve === "number");
  });

  test("risk limits are present", () => {
    assert.ok(typeof config.risk.maxPositions === "number");
    assert.ok(config.risk.maxPositions > 0);
  });
});
