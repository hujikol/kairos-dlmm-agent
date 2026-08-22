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

import { test, describe, beforeEach as _beforeEach, mock as _mock } from "node:test";
import assert from "node:assert";
import { computeManagementActions } from "../src/core/management-helpers.js";

// ─── Mock external dependencies ───────────────────────────────────────────────

const _mockPositions = [];
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
    velocityStopEnabled: true,
    velocityStopDropPct: 15,
    velocityStopWindowMin: 5,
    },
  risk: { maxPositions: 3 },
  schedule: { managementIntervalMin: 10 },
};

// Wraps computeManagementActions (which operates on an array) into a single-position call
// to preserve the test structure. getTrackedPosition mirrors the pnlSuspect lookup.
function computeAction(position, tracked, config) {
  const getTrackedPosition = (addr) => addr === position.position ? tracked : undefined;
  const actionMap = computeManagementActions([position], new Map(), config, getTrackedPosition);
  return actionMap.get(position.position);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Rule Engine — pnlSuspect detection", () => {

  test("NOT suspect: normal PnL reading", () => {
    const pos = { position: "pos1", pnl_pct: -20, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -18 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "STAY"); // -20% is above stopLoss (-50%), stays open
  });

  test("NOT suspect: first reading (prev_pnl_pct is null), extreme neg PnL", () => {
    // First reading ever — no prev_pnl_pct — should NOT flag as suspect by default
    const pos = { position: "pos1", pnl_pct: -95, total_value_usd: 0.005 }; // position value near zero
    const tracked = { amount_sol: 1, prev_pnl_pct: null };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // -95% < -50% stop loss → close
  });

  test("extreme drop with healthy prev is treated as REAL loss (not suspect) — closes", () => {
    // pnlSuspect only fires when prev was ALSO extreme (or null): a single glitched
    // reading from -5 to -95 is treated as a genuine crash → stop loss closes.
    // See src/core/management-helpers.js pnlSuspect: `prev == null || prev > PNL_SUSPECT_PCT`.
    const pos = { position: "pos1", pnl_pct: -95, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -5 }; // prev was fine → drop is real
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // stop loss fires
  });

  test("NOT suspect: position is genuinely near-zero value (real loss)", () => {
    const pos = { position: "pos1", pnl_pct: -95, total_value_usd: 0.005 }; // genuinely closed out
    const tracked = { amount_sol: 1, prev_pnl_pct: -90 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // value < $0.01, so not flagged as suspect
  });

  test("NOT suspect: prev reading was also extreme negative", () => {
    const pos = { position: "pos1", pnl_pct: -95, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -92 }; // prev was also bad — genuine loss
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE"); // prev also extreme → not a jump, likely real
  });
});

describe("Rule Engine — Rule 1: Stop Loss", () => {

  test("closes at exactly stopLossPct threshold", () => {
    const pos = { position: "pos1", pnl_pct: -50, total_value_usd: 0.8 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -48 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
    assert.equal(result.reason, "stop loss");
  });

  test("closes below stopLossPct threshold", () => {
    const pos = { position: "pos1", pnl_pct: -60, total_value_usd: 0.6 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -55 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
  });

  test("stays above stopLossPct threshold", () => {
    const pos = { position: "pos1", pnl_pct: -49, total_value_usd: 0.9 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -45 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 2: Take Profit", () => {

  test("closes at exactly takeProfitFeePct threshold", () => {
    const pos = { position: "pos1", pnl_pct: 5, total_value_usd: 1.2 };
    const tracked = { amount_sol: 1, prev_pnl_pct: 3 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 2);
    assert.equal(result.reason, "take profit");
  });

  test("closes above takeProfitFeePct threshold", () => {
    const pos = { position: "pos1", pnl_pct: 10, total_value_usd: 1.5 };
    const tracked = { amount_sol: 1, prev_pnl_pct: 7 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 2);
  });

  test("stays below takeProfitFeePct threshold", () => {
    const pos = { position: "pos1", pnl_pct: 4.9, total_value_usd: 1.1 };
    const tracked = { amount_sol: 1, prev_pnl_pct: 3 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 3: Pumped Far Above Range", () => {

  test("closes when active_bin is far above upper_bin", () => {
    const pos = { position: "pos1", active_bin: 150, upper_bin: 130, pnl_pct: 2 }; // 20 bins above > 10 threshold
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 3);
  });

  test("stays when active_bin is just above upper_bin (within threshold)", () => {
    const pos = { position: "pos1", active_bin: 140, upper_bin: 130, pnl_pct: 2 }; // 10 bins above = exactly threshold
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    // active_bin (140) > upper_bin (130) + outOfRangeBinsToClose (10) = 140 > 140 = false → no close
    assert.notEqual(result.action, "CLOSE");
  });

  test("no action when in range", () => {
    const pos = { position: "pos1", active_bin: 125, upper_bin: 130, pnl_pct: 2 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 4: Stale Above Range", () => {

  test("closes when OOR for exactly outOfRangeWaitMinutes", () => {
    const pos = { position: "pos1", active_bin: 135, upper_bin: 130, minutes_out_of_range: 30, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 4);
  });

  test("stays when OOR for less than outOfRangeWaitMinutes", () => {
    const pos = { position: "pos1", active_bin: 135, upper_bin: 130, minutes_out_of_range: 20, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });

  test("no action when in range even with high OOR minutes", () => {
    const pos = { position: "pos1", active_bin: 125, upper_bin: 130, minutes_out_of_range: 999, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 5: Low Fee Yield", () => {

  test("closes when fee_per_tvl_24h below threshold and position is old enough", () => {
    // Yield check requires MIN_POSITION_AGE_FOR_YIELD_CHECK_MS = 24h (constants.js:62)
    const pos = { position: "pos1", fee_per_tvl_24h: 5, age_minutes: 1440, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 5);
    assert.equal(result.reason, "low yield");
  });

  test("stays when fee_per_tvl_24h above threshold even if old", () => {
    const pos = { position: "pos1", fee_per_tvl_24h: 8, age_minutes: 120, pnl_pct: 0 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });

  test("stays when position is too young even if fee yield is low", () => {
    const pos = { position: "pos1", fee_per_tvl_24h: 5, age_minutes: 30, pnl_pct: 0 }; // < 60 min
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });
});

describe("Rule Engine — Rule 6: Claim", () => {

  test("CLAIM when unclaimed_fees_usd >= minClaimAmount", () => {
    const pos = { position: "pos1", unclaimed_fees_usd: 10, pnl_pct: 2, active_bin: 125, upper_bin: 130 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLAIM");
  });

  test("STAY when unclaimed_fees_usd < minClaimAmount and no other rules fire", () => {
    const pos = { position: "pos1", unclaimed_fees_usd: 2, pnl_pct: 2, active_bin: 125, upper_bin: 130 };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "STAY");
  });
});

describe("Rule Engine — Priority order", () => {

  test("stop loss takes priority over claim", () => {
    // If pnl is at stop loss AND there are fees to claim, stop loss wins
    const pos = { position: "pos1", pnl_pct: -60, unclaimed_fees_usd: 20, total_value_usd: 0.6 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -55 };
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
  });

  test("OOR rule fires before claim if both could apply", () => {
    // If active_bin > upper_bin for >= wait minutes, should close (OOR) not CLAIM
    // even if unclaimed fees exist
    const pos = {
      position: "pos1",
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

describe("Rule Engine — Velocity Stop", () => {

  test("CLOSE when drop within window meets threshold (samples newest-first)", () => {
    // Samples: age 1m pnl -20% (newest), age 4m pnl +2% (oldest in window)
    // → drop = -20 - 2 = -22% within 5m window
    const pos = {
      position: "pos1", pnl_pct: -20, total_value_usd: 1.5,
      pnl_samples: [{ age_minutes: 1, pnl_pct: -20 }, { age_minutes: 4, pnl_pct: 2 }],
    };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, "velocity_stop");
    assert.match(result.reason, /velocity stop/);
    assert.match(result.reason, /-22/);
  });

  test("does NOT fire when the same drop spread over longer than window", () => {
    // Oldest sample within 5m window is age 3 (+1%); drop from newest (0%) to it is only -1%
    // The big drop happened vs an older-than-window sample which must be ignored
    const pos = {
      position: "pos1", pnl_pct: 0, total_value_usd: 1.5,
      pnl_samples: [
        { age_minutes: 1, pnl_pct: 0 },
        { age_minutes: 3, pnl_pct: 1 },
        { age_minutes: 60, pnl_pct: 20 }, // outside window — ignored
      ],
    };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");
  });

  test("skips samples with missing/bad pnl_pct and empty/single-sample arrays", () => {
    // Only one valid sample in window → no baseline → no fire
    const pos = {
      position: "pos1", pnl_pct: -30, total_value_usd: 1.5,
      pnl_samples: [{ age_minutes: 2 }, { age_minutes: 4, pnl_pct: null }],
    };
    const tracked = {};
    const result = computeAction(pos, tracked, mockConfig);
    assert.notEqual(result.action, "CLOSE");

    // empty array
    const pos2 = { position: "pos2", pnl_pct: -30, total_value_usd: 1.5, pnl_samples: [] };
    const result2 = computeAction(pos2, tracked, mockConfig);
    assert.notEqual(result2.action, "CLOSE");
  });

  test("fallback: closes on cycle delta when no samples and prev_pnl_pct present", () => {
    const pos = { position: "pos1", pnl_pct: -18, total_value_usd: 1.5 };
    const tracked = {}; // getTrackedPosition returns tracked; prev read from pos.prev_pnl_pct
    const result = computeAction({ ...pos, prev_pnl_pct: -2 }, tracked, mockConfig);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, "velocity_stop");
    assert.match(result.reason, /cycle delta/);
  });

  test("no fallback fire when cycle delta smaller than threshold", () => {
    const result = computeAction(
      { position: "pos1", pnl_pct: -10, prev_pnl_pct: -5, total_value_usd: 1.5 },
      {}, mockConfig,
    );
    assert.notEqual(result.action, "CLOSE");
  });

  test("disabled via velocityStopEnabled: false", () => {
    const cfg = { ...mockConfig, management: { ...mockConfig.management, velocityStopEnabled: false } };
    const pos = {
      position: "pos1", pnl_pct: 2, total_value_usd: 1.5,
      pnl_samples: [{ age_minutes: 1, pnl_pct: 30 }, { age_minutes: 4, pnl_pct: -40 }],
    };
    const result = computeAction(pos, {}, cfg);
    assert.notEqual(result.action, "CLOSE");
  });

  test("boundary equality: exactly -15% drop fires", () => {
    const pos = {
      position: "pos1", pnl_pct: 0, total_value_usd: 1.5,
      pnl_samples: [{ age_minutes: 2, pnl_pct: 15 }],
    };
    const result = computeAction(pos, {}, mockConfig);
    assert.equal(result.action, "CLOSE"); // 0 - 15 = -15 <= -15
    assert.equal(result.rule, "velocity_stop");
  });
});

describe("Rule Engine — Age-based claim", () => {

  test("CLAIM when age >= maxClaimAgeMinutes and fees pending", () => {
    const cfg = { ...mockConfig, management: { ...mockConfig.management, maxClaimAgeMinutes: 240 } };
    const pos = { position: "pos1", unclaimed_fees_usd: 2, age_minutes: 300, pnl_pct: 2 };
    const result = computeAction(pos, {}, cfg);
    assert.equal(result.action, "CLAIM");
    assert.match(result.reason ?? "", /max claim age/);
  });

  test("does NOT override stop loss", () => {
    const cfg = { ...mockConfig, management: { ...mockConfig.management, maxClaimAgeMinutes: 60 } };
    const pos = { position: "pos1", pnl_pct: -60, unclaimed_fees_usd: 10, age_minutes: 500, total_value_usd: 0.6 };
    const tracked = { amount_sol: 1, prev_pnl_pct: -55 };
    const result = computeAction(pos, tracked, cfg);
    assert.equal(result.action, "CLOSE");
    assert.equal(result.rule, 1);
  });

  test("off when maxClaimAgeMinutes is null/absent", () => {
    const pos = { position: "pos1", unclaimed_fees_usd: 2, age_minutes: 99999, pnl_pct: 2 };
    const result = computeAction(pos, {}, mockConfig); // mockConfig has no maxClaimAgeMinutes
    assert.notEqual(result.action, "CLAIM");
  });
});
