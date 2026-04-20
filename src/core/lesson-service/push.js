/**
 * Hive mind push and decision log.
 *
 * Handles:
 *   - pushHiveLesson / pushHivePerformanceEvent (hive-mind.js)
 *   - recordDecision (decision-log.js)
 */

import { log } from "../logger.js";

/**
 * Push a lesson to the Hive Mind collective.
 * @param {Object} lesson
 * @returns {Promise<void>}
 */
export async function pushHiveLesson(lesson) {
  try {
    const { pushHiveLesson: _push } = await import("../../features/hive-mind.js");
    await _push(lesson);
  } catch (e) {
    log("warn", "hivemind", `pushHiveLesson failed: ${e?.message}`);
  }
}

/**
 * Push a performance event to the Hive Mind collective.
 * @param {Object} entry
 * @returns {Promise<void>}
 */
export async function pushHivePerformanceEvent(entry) {
  try {
    const { pushHivePerformanceEvent: _push } = await import("../../features/hive-mind.js");
    await _push(entry);
  } catch (e) {
    log("warn", "hivemind", `pushHivePerformanceEvent failed: ${e?.message}`);
  }
}

/**
 * Record a decision to the decision log.
 * @param {Object} params - { type, pool, position, amount, pnl, reasoning, metadata, initiatedBy }
 * @returns {Promise<void>}
 */
export async function recordDecision(params) {
  try {
    const { recordDecision: _record } = await import("../decision-log.js");
    await _record(params);
  } catch (e) {
    log("warn", "decision-log", `Failed to record decision: ${e?.message ?? String(e)}`);
  }
}