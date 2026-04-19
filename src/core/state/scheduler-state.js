// src/core/state/scheduler-state.js

/**
 * Extracted state from scheduler.js to break circular dependencies
 * between the scheduler cron engine and the cycle logic (management/screening).
 */

// ═══════════════════════════════════════════
//  CYCLE TIMERS (shared with index.js for buildPrompt)
// ═══════════════════════════════════════════
export const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

// ═══════════════════════════════════════════
//  CRON STATE
// ═══════════════════════════════════════════
// NOTE: Node.js v24 regressed — exported `let` bindings are read-only when imported.
// Use object wrapper so imported modules can modify properties (not bindings).
export const _busyState = {
  _managementBusy: false,
  _screeningBusy: false,
  _pnlPollBusy: false,
};

// Also use object wrapper for timestamps to avoid ESM live-binding reassignment issues
export const _timersState = {
  screeningLastTriggered: 0,
  pollTriggeredAt: 0,
};
