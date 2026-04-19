import { out, COMMAND_DEFAULTS } from "../utils.js";
import { getPerformanceHistory, getPerformanceSummary } from "../../core/lessons.js";

export async function performanceCmd(argv, flags) {
  const limit = flags.limit ? parseInt(flags.limit) : COMMAND_DEFAULTS.PERFORMANCE_LIMIT;
  const history = getPerformanceHistory({ hours: 999999, limit });
  const summary = getPerformanceSummary();
  out({ summary, ...history });
}
