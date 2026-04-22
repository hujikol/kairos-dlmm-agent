/**
 * Shared retry utility with configurable backoff strategies.
 *
 * Supports:
 * - Exponential or linear backoff
 * - Custom retryable error predicates
 * - Optional onRetry callback
 * - Configurable max attempts and delays
 */

import { SOLANA_BACKOFF_BASE_DELAY_MS, SOLANA_BACKOFF_MAX_DELAY_MS, METEORA_CLOSE_RETRY_DELAY_MS } from "./constants.js";

/**
 * Retry an async function with configurable backoff.
 *
 * @param {Function} fn - Async function to execute. Receives attempt number (1-based).
 *                          Should return a Promise that resolves on success.
 * @param {Object} options
 * @param {number} [options.maxAttempts=3] - Maximum number of attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds
 * @param {number} [options.backoffMultiplier=2] - Exponential multiplier (1 = linear)
 * @param {number} [options.maxDelayMs] - Cap on delay (exponential mode)
 * @param {number} [options.fixedDelayMs] - If set, use this fixed delay instead of backoff
 * @param {Function} [options.shouldRetry] - (err, attempt) => boolean. Return true to retry.
 *                                            For HTTP responses, also receives the response as second arg.
 * @param {Function} [options.onRetry] - (err, attempt, nextDelayMs) => void. Called before each retry.
 */
export async function retryWithBackoff(fn, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    backoffMultiplier = 2,
    maxDelayMs,
    fixedDelayMs,
    shouldRetry = () => true,
    onRetry,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await fn(attempt);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const retryable = shouldRetry(err, attempt, null);
      if (!retryable) throw err;
      const delay = fixedDelayMs ?? computeDelay(attempt, baseDelayMs, backoffMultiplier, maxDelayMs);
      if (onRetry) onRetry(err, attempt, delay);
      await sleep(delay);
      continue;
    }

    // Success path
    if (result.ok === false || result.status != null) {
      // HTTP response — check retryability
      const retryable = shouldRetry(null, attempt, result);
      if (!retryable) return result;
      if (attempt === maxAttempts) return result;
      const delay = fixedDelayMs ?? computeDelay(attempt, baseDelayMs, backoffMultiplier, maxDelayMs);
      if (onRetry) onRetry(null, attempt, delay, result);
      await sleep(delay);
    } else {
      // Non-HTTP success (e.g., direct return value)
      return result;
    }
  }
}

function computeDelay(attempt, baseDelayMs, backoffMultiplier, maxDelayMs) {
  const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  return maxDelayMs != null ? Math.min(delay, maxDelayMs) : delay;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Preset: HTTP 429 exponential backoff (solana.js pattern) ─────────────────

/**
 * Fetch with exponential backoff on HTTP 429.
 * Uses SOLANA_BACKOFF_BASE_DELAY_MS and SOLANA_BACKOFF_MAX_DELAY_MS.
 * Throws on non-429 error responses so callers can handle them.
 *
 * @param {string} url
 * @param {Object} options - fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithBackoff(url, options = {}) {
  return retryWithBackoff(
    async (_attempt) => {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After")
          ? parseInt(res.headers.get("Retry-After"))
          : null;
        throw Object.assign(new Error("429 rate limited"), {
          _isRetryable: true,
          _retryAfter: retryAfter,
          _response: res,
        });
      }
      return res;
    },
    {
      maxAttempts: 3,
      baseDelayMs: SOLANA_BACKOFF_BASE_DELAY_MS,
      backoffMultiplier: 2,
      maxDelayMs: SOLANA_BACKOFF_MAX_DELAY_MS,
      shouldRetry(err) {
        return err?._isRetryable === true;
      },
      onRetry(err, _attempt, delay) {
        import("./logger.js").then(({ log }) => {
          log("warn", "solana", `Rate limited (429), retrying in ${delay}ms`);
        });
      },
    },
  );
}

// ─── Preset: Fixed-delay retry (close.js verification pattern) ───────────────

/**
 * Retry with a fixed delay — useful for polling-style verification.
 * Uses METEORA_CLOSE_RETRY_DELAY_MS.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} [options]
 * @param {number} [options.maxAttempts=3]
 * @param {Function} [options.shouldRetry] - (err) => boolean
 * @param {Function} [options.onRetry] - (err, attempt) => void
 */
export async function retryWithFixedDelay(fn, options = {}) {
  const { maxAttempts = 3, shouldRetry = () => true, onRetry } = options;
  return retryWithBackoff(fn, {
    maxAttempts,
    fixedDelayMs: METEORA_CLOSE_RETRY_DELAY_MS,
    shouldRetry,
    onRetry: onRetry
      ? (err, attempt, _delayMs) => onRetry(err, attempt)
      : undefined,
  });
}
