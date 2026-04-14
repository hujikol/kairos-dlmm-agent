/**
 * Rate limiting utilities for the agent loop.
 */

import { log } from "../core/logger.js";

/**
 * Sleep helper.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error represents a rate limit (429).
 */
export function isRateLimitError(error) {
  const msg = error.message || String(error);
  return error.status === 429 ||
    msg.includes("429") ||
    msg.toLowerCase().includes("rate limit") ||
    msg.toLowerCase().includes("too many requests");
}

/**
 * Calculate exponential backoff for rate limit retries.
 * Caps at 120s after 3 retries per step.
 */
export function rateLimitBackoff(retryCount) {
  return Math.min(30000 * Math.pow(2, Math.max(0, retryCount - 1)), 120000);
}
