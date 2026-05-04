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

  // Note: Uses SIZING_MATRIX (not deployAmountSol):
  //   normal: { other: 0.50 }
  //   very_high: { 0: 1.50, other: 1.00 }
  //   high: { other: 1.00 }
  // Config: gasReserve=0.2, maxDeployAmount=50

  test("returns calculated amount for small wallet (normal conviction)", () => {
    // walletSol = 0.5, reserve = 0.2, deployable = 0.3
    // target = 0.50 (normal), ceil = min(50, 0.3) = 0.3
    // amount = min(0.3, 0.50) = 0.3
    const result = computeDeployAmount(0.5);
    assert.strictEqual(result.amount, 0.3);
    assert.strictEqual(result.error, null);
  });

  test("returns calculated amount when wallet is large (normal conviction)", () => {
    // walletSol = 10, deployable = 9.8, target = 0.50 (normal)
    // ceil = min(50, 9.8) = 9.8, amount = min(9.8, 0.50) = 0.50
    const result = computeDeployAmount(10);
    assert.strictEqual(result.amount, 0.50);
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

  test("very_high conviction with 0 positions uses 1.50 target", () => {
    // walletSol = 5, deployable = 4.95, target = 1.50 (very_high, 0 positions)
    const result = computeDeployAmount(5, 0, "very_high");
    assert.strictEqual(result.amount, 1.5);
    assert.strictEqual(result.error, null);
  });

  test("very_high conviction with 1+ positions uses 1.00 target", () => {
    // walletSol = 5, deployable = 4.95, target = 1.00 (very_high, 1+ positions)
    const result = computeDeployAmount(5, 1, "very_high");
    assert.strictEqual(result.amount, 1.0);
    assert.strictEqual(result.error, null);
  });

  test("high conviction uses 1.00 target", () => {
    const result = computeDeployAmount(5, 0, "high");
    assert.strictEqual(result.amount, 1.0);
    assert.strictEqual(result.error, null);
  });

  test("normal conviction uses 0.50 target", () => {
    // walletSol = 100, deployable = 99.95, target = 0.50 (normal)
    // ceil = min(maxDeployAmount, 99.95)
    const result = computeDeployAmount(100);
    assert.strictEqual(result.amount, 0.5);
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
