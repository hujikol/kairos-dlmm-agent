/**
 * Darwinian signal weighting entry point.
 *
 * Thin wrapper around signal-weights.js that checks config.darwin.enabled
 * before invoking recalculateWeights. Called from recordPerformance().
 */

import { recalculateWeights } from "./signal-weights.js";
import { log } from "./logger.js";

/**
 * Recalculate Darwin signal weights if enabled in config.
 * @param {Array}  allPerformance - All performance records
 * @param {Object} config         - Runtime config
 * @returns {{ changes: Array } | null}
 */
export async function recalculateDarwinWeights(allPerformance, config) {
  if (!config.darwin?.enabled) return null;
  const wResult = await recalculateWeights(allPerformance, config);
  if (wResult.changes.length > 0) {
    log("info", "evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
  }
  return wResult;
}