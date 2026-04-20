/**
 * Lesson service — orchestration layer for recordPerformance and learning stats.
 *
 * Barrel re-export. Actual logic split across:
 *   - record.js    — recordPerformance + DB writes + pruning
 *   - evolve.js    — threshold evolution + darwin weights
 *   - push.js      — hive mind push + decision log
 */

export {
  recordPerformance,
  derivLesson,
  prunePerformance,
  pruneNearMisses,
  getLearningStats,
  getPerformanceSummary,
  getPerformanceHistory,
  PERFORMANCE_ARCHIVE_THRESHOLD,
  PERFORMANCE_KEEP,
  NEAR_MISS_MAX_DAYS,
} from "./lesson-service/record.js";

export {
  evolveThresholds,
  recalculateDarwinWeights,
  MIN_EVOLVE_POSITIONS,
} from "./lesson-service/evolve.js";

export {
  pushHiveLesson,
  pushHivePerformanceEvent,
  recordDecision,
} from "./lesson-service/push.js";