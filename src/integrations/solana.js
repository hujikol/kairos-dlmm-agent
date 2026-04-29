import { Connection } from "@solana/web3.js";
import { fetchWithBackoff as _fetchWithBackoff } from "../core/retry.js";

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

/**
 * Generic fetch with exponential backoff on 429 (rate limited).
 * Delegates to the shared retry utility in src/core/retry.js.
 */
export async function fetchWithBackoff(url, options = {}) {
  return _fetchWithBackoff(url, options);
}
