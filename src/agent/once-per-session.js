/**
 * Once-per-session tool deduplication.
 * Blocks certain tools from executing more than once per agent session.
 */

// Tools that should only fire once per session
const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);

// These lock after first attempt regardless of outcome
const NO_RETRY_TOOLS = new Set(["deploy_position"]);

export { ONCE_PER_SESSION, NO_RETRY_TOOLS };

/**
 * Check if a tool can run (hasn't already fired this session).
 * @param {string} toolName
 * @param {Set<string>} firedOnce - set of tools already executed
 * @returns {boolean} true if tool can run
 */
export function canRun(toolName, firedOnce) {
  if (!ONCE_PER_SESSION.has(toolName)) return true;
  return !firedOnce.has(toolName);
}

/**
 * Record that a tool was executed.
 * @param {string} toolName
 * @param {boolean} success - whether the tool call succeeded
 * @param {Set<string>} firedOnce - set to update
 */
export function recordRun(toolName, success, firedOnce) {
  if (NO_RETRY_TOOLS.has(toolName)) {
    firedOnce.add(toolName);
  } else if (ONCE_PER_SESSION.has(toolName) && success) {
    firedOnce.add(toolName);
  }
}

/**
 * Create a fresh firedOnce tracker.
 * @returns {Set<string>}
 */
export function createFiredOnceTracker() {
  return new Set();
}