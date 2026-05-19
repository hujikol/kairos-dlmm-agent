export class RetryError extends Error {
  constructor(message, cause, retries) {
    super(message);
    this.name = "RetryError";
    this.cause = cause;
    this.retries = retries;
  }
}

export const ErrorType = {
  NETWORK: "NETWORK",
  RATE_LIMIT: "RATE_LIMIT",
  VALIDATION: "VALIDATION",
  UNKNOWN: "UNKNOWN",
};

export function classifyError(err) {
  const msg = err?.message || "";
  const status = err?.status || err?.statusCode || 0;
  if (status === 429 || msg.toLowerCase().includes("rate limit")) return ErrorType.RATE_LIMIT;
  if (status >= 500 || /socket|timeout|network|econnreset|ECONNREFUSED/i.test(msg)) return ErrorType.NETWORK;
  if (status === 400 || status === 422 || /invalid|validation/i.test(msg)) return ErrorType.VALIDATION;
  return ErrorType.UNKNOWN;
}

export async function withRetry(fn, {
  maxRetries = 3,
  initialDelayMs = 1000,
  maxDelayMs = 10000,
  shouldRetry = (e) => classifyError(e) !== ErrorType.VALIDATION,
} = {}) {
  let lastError;
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !shouldRetry(err)) {
        throw new RetryError(`Failed after ${attempt} retries: ${err.message}`, err, attempt);
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  throw lastError;
}