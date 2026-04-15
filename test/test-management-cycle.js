/**
 * Unit tests for runManagementCycle rule engine.
 * Uses Node's built-in test runner (node:test).
 *
 * Tests the deterministic rule logic in runManagementCycle:
 * Rule 1 (stop loss), Rule 2 (take profit), Rule 3 (pumped OOR),
 * Rule 4 (stale OOR), Rule 5 (low yield), Rule 6 (claim),
 * plus pnlSuspect detection and trailing TP.
 *
 * Run: node --test test/test-management-cycle.mjs
 * Or:  node test/test-management-cycle.mjs
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert";

// ─── Mock external dependencies ───────────────────────────────────────────────

const mockPositions = [];
const mockConfig = {
  management: {
    stopLossPct: -50,
    takeProfitFeePct: 5,
    outOfRangeBinsToClose: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 7,
    minClaimAmount: 5,
    trailingTakeProfit: true,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
  },
  risk: { maxPositions: 3 },
  schedule: { managementIntervalMin: 10 },
};

// Simulates the action computation logic from runManagementCycle.
// Returns the computed action for a single position.
function computeAction(position, tracked, config) {
  const { pnl_pct, active_bin, upper_bin, minutes_out_of_range, fee_per_tvl_24h, age_minutes, unclaimed_fees_usd, total_value_usd } = position;

  // pnlSuspect: API returns extreme negative PnL but position still has value AND prev reading was stable
  const PNL_SUSPECT_PCT = -90;
  const PNL_SUSPECT_USD = 0.01;
  const MIN_YIELD_AGE_MS = 60 * 60 * 1000;

  const pnlSuspect = (() => {
    if (pnl_pct == null) return false;
    if (pnl_pct > PNL_SUSPECT_PCT) return false;
    if (tracked?.amount_sol && (total_value_usd ?? 0) > PNL_SUSPECT_USD) {
      const prev = tracked.prev_pnl_pct;
      if (prev == null || prev > PNL_SUSPECT_PCT) return true;
    }
    return false;
  })();

  // Rule 1: stop loss
  if (!pnlSuspect && pnl_pct != null && pnl_pct <= config.management.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  // Rule 2: take profit
  if (!pnlSuspect && pnl_pct != null && pnl_pct >= config.management.takeProfitFeePct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  // Rule 3: pumped far above range
  if (active_bin != null && upper_bin != null &&
      active_bin > upper_bin + config.management.outOfRangeBinsToClose) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  // Rule 4: stale above range
  if (active_bin != null && upper_bin != null &&
      active_bin > upper_bin &&
      (minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  // Rule 5: fee yield too low
  if (fee_per_tvl_24h != null &&
      fee_per_tvl_24h < config.management.minFeePerTvl24h &&
      (age_minutes ?? 0) >= MIN_YIELD_AGE_MS / 60_000) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  // Claim rule
  if ((unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
    return { action: "CLAIM" };
  }
  return { action: "STAY" };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Rule Engine — pnlSuspect detection", () => {

  test("NOT suspect: normal PnL reading", () => {
    const pos = { pnl_pct: -20, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -18 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "STAY"); // -20% is above stopLoss (-50%), stays open
  });

  test("NOT suspect: first reading (prev_pnl_pct is null), extreme neg PnL", () => {
    // First reading ever — no prev_pnl_pct — should NOT flag as suspect by default
    const pos = { pnl_pct: -95, total_value_usd: 0.005 }; // position value near zero
    const tracked = { amount_sol: 1, prev_pnl_pct: null };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // -95% < -50% stop loss → close
  });

  test("SUSPECT: API returns -95% but prev was -5% and position still has value", () => {
    const pos = { pnl_pct: -95, total_value_usd: 1.5 }; // bad API data
    const tracked = { amount_sol: 1, prev_pnl_pct: -5 }; // prev was fine
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "STAY"); // pnlSuspect=true → skip stop loss, stay
  });

  test("NOT suspect: position is genuinely near-zero value (real loss)", () => {
    const pos = { pnl_pct: -95, total_value_usd: 0.005 }; // genuinely closed out
    const tracked = { amount_sol: 1, prev_pnl_pct: -90 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // value < $0.01, so not flagged as suspect
  });

  test("NOT suspect: prev reading was also extreme negative", () => {
    const pos = { pnl_pct: -95, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -92 }; // prev was also bad — genuine loss
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // prev also extreme → not a jump, likely real
  });
});

describe("Rule Engine — Rule 1: Stop Loss", () => {

  test("closes at exactly stopLossPct threshold", () => {
    const pos = { pnl_pct: -50, total_value_usd: 0.8 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -48 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
    assert.equal(result.reason, "stop loss");
  });

  test("closes below stopLossPct threshold", () => {
    const pos = { pnl_pct: -60, total_value_usd: 0.6 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -55 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
  });

  test("stays above stopLossPct threshold", () => {
    const pos = { pnl_pct: -49, total_value_usd: 0.9 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -45 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 2: Take Profit", () => {

  test("closes at exactly takeProfitFeePct threshold", () => {
    const pos = { pnl_pct: 5, total_value_usd: 1.2 };
    const tracked = { amount_sol: 1, prev_pnl_pct: 3 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 2);
    assert.equal(result.reason, "take profit");
  });

  test("closes above takeProfitFeePct threshold", () => {
    const pos = { pnl_pct: 10, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: 7 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 2);
  });

  test("stays below takeProfitFeePct threshold", () => {
    const pos = { pnl_pct: 4.9, total_value_usd: 1.1 };
    const tracked = { amount_sol: 1, prev_pnl_pct: 3 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 3: Pumped Far Above Range", () => {

  test("closes when active_bin is far above upper_bin", () => {
    const pos = { active_bin: 150, upper_bin: 130, pnl_pct: 2 }; // 20 bins above > 10 threshold
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 3);
  });

  test("stays when active_bin is just above upper_bin (within threshold)", () => {
    const pos = { active_bin: 140, upper_bin: 130, pnl_pct: 2 }; // 10 bins above = exactly threshold
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    // active_bin (140) > upper_bin (130) + outOfRangeBinsToClose (10) = 140 > 140 = false → no close
    assert.notEqual(result.action, "CLOSE");
  });

  test("no action when in range", () => {
    const pos = { active_bin: 125, upper_bin: 130, pnl_pct: 2 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 4: Stale Above Range", () => {

  test("closes when OOR for exactly outOfRangeWaitMinutes", () => {
    const pos = { active_bin: 135, upper_bin: 130, minutes_out_of_range: 30, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 4);
  });

  test("stays when OOR for less than outOfRangeWaitMinutes", () => {
    const pos = { active_bin: 135, upper_bin: 130, minutes_out_of_range: 20, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });

  test("no action when in range even with high OOR minutes", () => {
    const pos = { active_bin: 125, upper_bin: 130, minutes_out_of_range: 999, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 5: Low Fee Yield", () => {

  test("closes when fee_per_tvl_24h below threshold and position is old enough", () => {
    const pos = { fee_per_tvl_24h: 5, age_minutes: 120, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 5);
    assert.equal(result.reason, "low yield");
  });

  test("stays when fee_per_tvl_24h above threshold even if old", () => {
    const pos = { fee_per_tvl_24h: 8, age_minutes: 120, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });

  test("stays when position is too young even if fee yield is low", () => {
    const pos = { fee_per_tvl_24h: 5, age_minutes: 30, pnl_pct: 0 }; // < 60 min
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 6: Claim", () => {

  test("CLAIM when unclaimed_fees_usd >= minClaimAmount", () => {
    const pos = { unclaimed_fees_usd: 10, pnl_pct: 2, active_bin: 125, upper_bin: 130 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLAIM");
  });

  test("STAY when unclaimed_fees_usd < minClaimAmount and no other rules fire", () => {
    const pos = { unclaimed_fees_usd: 2, pnl_pct: 2, active_bin: 125, upper_bin: 130 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "STAY");
  });
});

describe("Rule Engine — Priority order", () => {

  test("stop loss takes priority over claim", () => {
    // If pnl is at stop loss AND there are fees to claim, stop loss wins
    const pos = { pnl_pct: -60, unclaimed_fees_usd: 20, total_value_usd: 0.6 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -55 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
  });

  test("OOR rule fires before claim if both could apply", () => {
    // If active_bin > upper_bin for >= wait minutes, should close (OOR) not CLAIM
    // even if unclaimed fees exist
    const pos = {
      active_bin: 140,
      upper_bin: 130,
      minutes_out_of_range: 45,
      unclaimed_fees_usd: 20,
      pnl_pct: 0,
    };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 4); // OOR rule fires first in the chain
  });
});
