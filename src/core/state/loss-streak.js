/**
 * Loss-streak tracking state.
 * Tracks consecutive loss cycles per position to gate re-entry decisions.
 */

let _streakMap = new Map();

export function _injectStreakMap(map) {
  _streakMap = map;
}

export function _getStreakMap() {
  return _streakMap;
}
