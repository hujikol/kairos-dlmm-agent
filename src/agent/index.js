/**
 * Agent module — ReAct loop with intent classification, tool filtering,
 * model fallback, JSON repair, and rate limiting.
 */
export { agentLoop } from "./react.js";
export { INTENT_PATTERNS, INTENT_TOOLS, shouldRequireRealToolUse, DEFAULT_MODEL, FALLBACK_MODEL } from "./intent.js";
export { MANAGER_TOOLS, SCREENER_TOOLS, getToolsForRole } from "./tools.js";
export { callWithRetry, client } from "./fallback.js";
export { parseToolArgs } from "./repair.js";
export { isRateLimitError, rateLimitBackoff, sleep } from "./rate.js";
