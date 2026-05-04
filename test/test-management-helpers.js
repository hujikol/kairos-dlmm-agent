// ══════════════════════════════════════════════════════════════
// Set env BEFORE any imports — ESM hoists all imports before
// module-body code runs, so this MUST come first.
// ══════════════════════════════════════════════════════════════
process.env.WALLET_PRIVATE_KEY = "[]";
process.env.RPC_URL = "https://api.mainnet-beta.solana.com";

import { describe, it } from "node:test";
import assert from "node:assert";
import { computeManagementActions } from "../src/core/management-helpers.js";
import { _injectStreakMap } from "../src/core/state/loss-streak.js";

function makeConfig() {
  return {
    management: {
      stopLossPct: -5,
      takeProfitFeePct: 15,
      outOfRangeBinsToClose: 50,
      outOfRangeWaitMinutes: 60,
      minFeePerTvl24h: 0.0001,
      minClaimAmount: 0.5,
      lossStreakEnabled: true,
      lossStreakThreshold: 3,
      lossStreakMinPositionAgeCycles: 2,
      solMode: false,
    },
    schedule: {
      managementIntervalMin: 10,
    },
  };
}

describe("computeManagementActions", () => {
  it("returns CLOSE when position is in exitMap", () => {
    _injectStreakMap(new Map());

    const positionData = [{
      position: "pos1",
      pair: "SOL/USDC",
      pnl_pct: 2,
      age_minutes: 30,
    }];
    const exitMap = new Map([["pos1", "trailing TP hit"]]);
    const config = makeConfig();
    const getTrackedPosition = () => null;

    const result = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    assert.strictEqual(result.get("pos1").action, "CLOSE");
    assert.strictEqual(result.get("pos1").rule, "exit");
  });

  it("returns CLOSE for stop loss rule", () => {
    _injectStreakMap(new Map());

    const positionData = [{
      position: "pos2",
      pair: "SOL/USDC",
      pnl_pct: -6,
      age_minutes: 30,
    }];
    const exitMap = new Map();
    const config = makeConfig();
    const getTrackedPosition = () => null;

    const result = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    assert.strictEqual(result.get("pos2").action, "CLOSE");
    assert.strictEqual(result.get("pos2").rule, 1);
    assert.strictEqual(result.get("pos2").reason, "stop loss");
  });

  it("returns CLOSE for take profit rule", () => {
    _injectStreakMap(new Map());

    const positionData = [{
      position: "pos3",
      pair: "SOL/USDC",
      pnl_pct: 20,
      age_minutes: 30,
    }];
    const exitMap = new Map();
    const config = makeConfig();
    const getTrackedPosition = () => null;

    const result = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    assert.strictEqual(result.get("pos3").action, "CLOSE");
    assert.strictEqual(result.get("pos3").rule, 2);
    assert.strictEqual(result.get("pos3").reason, "take profit");
  });

  it("returns CLAIM when unclaimed_fees_usd exceeds minClaimAmount", () => {
    _injectStreakMap(new Map());

    const positionData = [{
      position: "pos4",
      pair: "SOL/USDC",
      pnl_pct: 1,
      age_minutes: 30,
      unclaimed_fees_usd: 1.0,
      total_value_usd: 10,
      fee_per_tvl_24h: 0.01,
    }];
    const exitMap = new Map();
    const config = makeConfig();
    const getTrackedPosition = () => null;

    const result = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    assert.strictEqual(result.get("pos4").action, "CLAIM");
  });

  it("returns STAY when no rules match", () => {
    _injectStreakMap(new Map());

    const positionData = [{
      position: "pos5",
      pair: "SOL/USDC",
      pnl_pct: 2,
      age_minutes: 30,
      fee_per_tvl_24h: 0.01,
      unclaimed_fees_usd: 0.1,
    }];
    const exitMap = new Map();
    const config = makeConfig();
    const getTrackedPosition = () => null;

    const result = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    assert.strictEqual(result.get("pos5").action, "STAY");
  });

  it("returns INSTRUCTION when position has instruction set", () => {
    _injectStreakMap(new Map());

    const positionData = [{
      position: "pos6",
      pair: "SOL/USDC",
      pnl_pct: 5,
      instruction: "hold for news",
    }];
    const exitMap = new Map();
    const config = makeConfig();
    const getTrackedPosition = () => null;

    const result = computeManagementActions(positionData, exitMap, config, getTrackedPosition);

    assert.strictEqual(result.get("pos6").action, "INSTRUCTION");
  });
}).then(() => { process.exit(0); });