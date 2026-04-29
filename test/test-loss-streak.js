import { test } from "node:test";
import assert from "node:assert/strict";
import { getStreak, incrementStreak, resetStreak, _injectStreakMap } from "../src/core/state/loss-streak.js";
import { computeManagementActions } from "../src/core/management-helpers.js";

test("Loss Streak - Basic Tracking", () => {
  const map = new Map();
  _injectStreakMap(map);
  const pos = "Pos1";

  assert.equal(getStreak(pos), 0);
  
  incrementStreak(pos);
  incrementStreak(pos);
  assert.equal(getStreak(pos), 2);
  
  resetStreak(pos);
  assert.equal(getStreak(pos), 0);
});

test("Loss Streak - Action Trigger", () => {
  const map = new Map();
  _injectStreakMap(map);
  const posAddress = "Pos2";

  map.set(posAddress, 3); // Loss streak of 3

  const positionData = [{
    position: posAddress,
    pair: "TEST/SOL",
    pnl_pct: -1.5,
    in_range: true,
    age_minutes: 30, // 30 mins > 2 cycles of 10 min
  }];

  const exitMap = new Map();
  const config = {
    management: {
      lossStreakEnabled: true,
      lossStreakThreshold: 3,
      lossStreakMinPositionAgeCycles: 2,
    },
    schedule: {
      managementIntervalMin: 10
    }
  };

  const getTrackedPosition = () => ({});

  const actions = computeManagementActions(positionData, exitMap, config, getTrackedPosition);
  
  assert.equal(actions.get(posAddress).action, "CLOSE");
  assert.equal(actions.get(posAddress).rule, "loss_streak");
});

test("Loss Streak - Disabled or Under Threshold", () => {
  const map = new Map();
  _injectStreakMap(map);
  const posAddress = "Pos3";

  map.set(posAddress, 2); // Under threshold of 3

  const positionData = [{
    position: posAddress,
    pair: "TEST/SOL",
    pnl_pct: -1.5,
    in_range: true,
    age_minutes: 30,
    instruction: "HOLD", // Instruction takes priority if Loss Streak doesn't trigger
  }];

  const exitMap = new Map();
  const config = {
    management: {
      lossStreakEnabled: true,
      lossStreakThreshold: 3,
      lossStreakMinPositionAgeCycles: 2,
    },
    schedule: {
      managementIntervalMin: 10
    }
  };

  const actions = computeManagementActions(positionData, exitMap, config, () => ({}));
  
  // Since threshold not met, it should fall back to INSTRUCTION
  assert.equal(actions.get(posAddress).action, "INSTRUCTION");
});

test("Loss Streak - Insufficient Age", () => {
  const map = new Map();
  _injectStreakMap(map);
  const posAddress = "Pos4";

  map.set(posAddress, 3); // Streak is 3, but position is too new

  const positionData = [{
    position: posAddress,
    pair: "TEST/SOL",
    pnl_pct: -1.5,
    in_range: true,
    age_minutes: 15, // Less than 2 * 10 = 20 mins
  }];

  const exitMap = new Map();
  const config = {
    management: {
      lossStreakEnabled: true,
      lossStreakThreshold: 3,
      lossStreakMinPositionAgeCycles: 2,
    },
    schedule: {
      managementIntervalMin: 10
    }
  };

  const actions = computeManagementActions(positionData, exitMap, config, () => ({}));
  
  // Since age not met, it falls through to STAY (or whatever else)
  assert.equal(actions.get(posAddress).action, "STAY");
});
