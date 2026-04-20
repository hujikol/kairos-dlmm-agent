let _lossStreakMap = new Map();

export function getStreak(position) {
  return _lossStreakMap.get(position) ?? 0;
}

export function incrementStreak(position) {
  const current = getStreak(position);
  _lossStreakMap.set(position, current + 1);
}

export function resetStreak(position) {
  _lossStreakMap.delete(position);
}

// test injection helper
export function _injectStreakMap(map) {
  _lossStreakMap = map;
}
