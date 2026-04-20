/**
 * Persistent agent state — re-exports all public APIs from sub-modules.
 *
 * Sub-modules:
 *   registry.js  — position CRUD: trackPosition, updatePosition, getTrackedPositions,
 *                  getTrackedPosition, recordRebalance, recordClaim, recordClose,
 *                  setPositionInstruction, getStateSummary
 *   oor.js       — OOR tracking: markOutOfRange, markInRange, minutesOutOfRange
 *   events.js    — event log: pushEvent, getRecentEvents
 *   pnl.js       — updatePnlAndCheckExits (peak_pnl_pct, prev_pnl_pct, trailing_active,
 *                  4 exit signals, volatility-adaptive adjustments)
 *   sync.js      — syncOpenPositions (state reconciliation with on-chain)
 *
 * All modules share the same getDB() from ./db.js — no separate connections.
 */

import { getDB, initSchema } from "../db.js";

// Re-export getDB and initSchema for any callers that need them directly
export { getDB, initSchema };

// ─── Re-export all sub-module public APIs ─────────────────────────────────────

// registry
export {
  trackPosition,
  updatePositionStatus,
  recordClose,
  recordRebalance,
  recordClaim,
  setPositionInstruction,
  getTrackedPositions,
  getTrackedPosition,
  _injectTrackedPosition,
  getStateSummary,
  touchLastUpdated,
} from "./registry.js";

export { getLastBriefingDate, setLastBriefingDate } from "./registry.js";

// oor
export { markOutOfRange, markInRange, minutesOutOfRange } from "./oor.js";

// events
export { pushEvent, getRecentEvents } from "./events.js";

// pnl — importable and testable standalone
export { updatePnlAndCheckExits } from "./pnl.js";

// sync
export { syncOpenPositions } from "./sync.js";

// loss-streak
export { getStreak, incrementStreak, resetStreak, _injectStreakMap } from "./loss-streak.js";
