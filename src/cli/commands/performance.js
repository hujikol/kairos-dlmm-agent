import { out, COMMAND_DEFAULTS } from "../utils.js";
import { getPerformanceHistory, getPerformanceSummary } from "../../core/lessons.js";

export async function performanceCmd(argv, flags) {
  const limit = flags.limit ? parseInt(flags.limit) : COMMAND_DEFAULTS.PERFORMANCE_LIMIT;
  const history = await getPerformanceHistory({ hours: 999999, limit });
  const summary = await getPerformanceSummary();
  out({ summary, ...history });
}
