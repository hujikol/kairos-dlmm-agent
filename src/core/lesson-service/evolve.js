/**
 * Threshold evolution and Darwin weights.
 *
 * Handles:
 *   - evolveThresholds() from threshold-evolver.js
 *   - recalculateDarwinWeights() from darwin-weights.js (wrapped)
 */

import { evolveThresholds, MIN_EVOLVE_POSITIONS } from "../threshold-evolver.js";
import { recalculateDarwinWeights as _recalculateDarwinWeights } from "../darwin-weights.js";

// Re-export for consumers
export { evolveThresholds, MIN_EVOLVE_POSITIONS };

/**
 * Recalculate Darwin signal weights if enabled in config.
 * @param {Array} allPerformance
 * @param {Object} config
 * @returns {{ changes: Array } | null}
 */
export async function recalculateDarwinWeights(allPerformance, config) {
  return _recalculateDarwinWeights(allPerformance, config);
}