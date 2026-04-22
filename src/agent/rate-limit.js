/**
 * Rate-limit retry logic for the agent loop.
 */

import { isRateLimitError as _isRateLimitError, rateLimitBackoff as _rateLimitBackoff, sleep as _sleep } from "./rate.js";

/**
 * Handle a rate limit error during agent loop.
 * Throws if rate limited 3+ times consecutively.
 * @param {Error} error
 * @param {number} rateLimitRetryCount - current retry count
 * @returns {{ retryCount: number, backoffMs: number } | null} null if not rate limit
 * @throws {Error} if rate limited 3+ times
 */
export function handleRateLimitError(error, rateLimitRetryCount) {
  if (!_isRateLimitError(error)) return null;

  const retryCount = rateLimitRetryCount + 1;
  const backoffMs = _rateLimitBackoff(retryCount);

  if (retryCount >= 3) {
    throw new Error("Rate limited 3 times consecutively — aborting agent loop");
  }

  return { retryCount, backoffMs };
}