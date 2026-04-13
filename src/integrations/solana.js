import { Connection } from "@solana/web3.js";

let _connection = null;

/**
 * Get (or create) a shared Solana RPC connection with keep-alive.
 * All modules should import this instead of creating their own.
 */
export function getConnection(commitment = "confirmed") {
  if (_connection) return _connection;
  _connection = new Connection(process.env.RPC_URL, {
    commitment,
    disableRetryOnRateLimited: false,
  });
  return _connection;
}

/**
 * Reset the shared connection (e.g. when RPC URL changes).
 */
export function resetConnection() {
  _connection = null;
}

// ─── Rate limit backoff ──────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY = parseInt(process.env.SOLANA_BACKOFF_BASE_DELAY_MS || "1000");

/**
 * Generic fetch with exponential backoff on 429 (rate limited).
 */
export async function fetchWithBackoff(url, options = {}) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After")
          ? parseInt(res.headers.get("Retry-After"))
          : BASE_DELAY * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, Math.min(retryAfter, parseInt(process.env.SOLANA_BACKOFF_MAX_DELAY_MS || "30000"))));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, BASE_DELAY * Math.pow(2, attempt - 1)));
    }
  }
}
