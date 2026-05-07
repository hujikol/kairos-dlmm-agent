/**
 * Centralized Agent Meridian relay client.
 *
 * All requests to Agent Meridian (PnL, Top LP, Study Top LP) route through here.
 * No LPAgent API key needed on the user side — the relay handles it.
 *
 * Setup (user-config.json):
 *   {
 *     "publicApiKey": "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz",
 *     "agentMeridianApiUrl": "https://api.agentmeridian.xyz/api",
 *     "lpAgentRelayEnabled": true
 *   }
 */

import { config } from "../config.js";
import dns from "dns";

// Force IPv4 to avoid IPv6 issues with the Agent Meridian relay
dns.setDefaultResultOrder("ipv4first");

const DEFAULT_BASE = "https://api.agentmeridian.xyz/api";

export function getAgentMeridianBase() {
  // Support: api.url (new flat), hive.url (hive nested), hiveMind.url (legacy)
  const url = config.api?.url || config.hiveMind?.url || DEFAULT_BASE;
  return String(url).replace(/\/+$/, "");
}

export function getAgentMeridianHeaders({ json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  // Agent Meridian relay authenticates via x-api-key with the publicApiKey
  const key = config.api?.publicApiKey || config.hiveMind?.apiKey || process.env.PUBLIC_API_KEY;
  if (key) headers["x-api-key"] = key;
  // Discord signal preferences — relay needs these to know whether to inject Discord pools
  if (config.screening?.useDiscordSignals !== undefined) {
    headers["x-discord-signals"] = String(config.screening.useDiscordSignals);
  }
  if (config.screening?.discordSignalMode) {
    headers["x-discord-mode"] = config.screening.discordSignalMode;
  }
  // LPAgent relay capability — lets the relay know this agent has an LPAGENT_API_KEY
  // so it can use the richer LPAgent-backed endpoints (positions, PnL, top-lp)
  if (process.env.LPAGENT_API_KEY) {
    headers["x-lpagent-api-key"] = process.env.LPAGENT_API_KEY;
  }
  return headers;
}

export function getAgentIdForRequests() {
  return config.hiveMind?.agentId || "agent-local";
}

// ─── Fetch with AbortController timeout ──────────────────────────────────────

/**
 * Wraps fetch with an AbortController timeout.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Propagate parent signal if provided
  const { signal: parentSignal, ...restOptions } = options;
  if (parentSignal) {
    // Race: if parent aborts, abort our controller
    parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const fetchOptions = {
    ...restOptions,
    signal: controller.signal,
  };

  return fetch(url, fetchOptions).finally(() => clearTimeout(timer));
}

// ─── Retry helpers ───────────────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Returns true for retryable HTTP status codes (5xx + 408, 409, 425, 429) */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Compute retry delay in ms.
 * @param {Error|Response} errorOrResponse
 * @param {number} attempt — 0-indexed attempt number
 * @returns {number}
 */
export function retryDelayMs(errorOrResponse, attempt) {
  // Respect Retry-After header (max 10s)
  const retryAfter = errorOrResponse?.headers?.get?.("Retry-After");
  if (retryAfter) {
    const delay = Math.min(Number(retryAfter) * 1000, 10_000);
    if (!isNaN(delay)) return delay;
  }
  // Exponential backoff: min(500 * 2^attempt, 5000)
  return Math.min(500 * Math.pow(2, attempt), 5000);
}

/**
 * Sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch JSON from Agent Meridian with optional retry/backoff.
 *
 * @param {string} pathname
 * @param {object} options
 * @param {object} [options.retry]
 * @param {number} [options.retry.maxAttempts]    — default 10
 * @param {number} [options.retry.maxElapsedMs]    — default 30_000 (30s total budget)
 * @param {number} [options.retry.perAttemptTimeoutMs] — default 10_000 (per-attempt timeout)
 * @returns {Promise<object>}
 */
export async function agentMeridianJson(pathname, options = {}) {
  const retry = options.retry;

  // ── No retry path: call once and return ────────────────────────────────────
  if (!retry) {
    return agentMeridianFetch(pathname, options);
  }

  // ── Retry path ─────────────────────────────────────────────────────────────
  const maxAttempts = retry.maxAttempts ?? 10;
  const maxElapsedMs = retry.maxElapsedMs ?? 30_000;
  const perAttemptTimeoutMs = retry.perAttemptTimeoutMs ?? 10_000;
  const startTime = Date.now();

  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check total elapsed budget
    if (Date.now() - startTime >= maxElapsedMs) {
      throw lastError;
    }

    try {
      const result = await agentMeridianFetch(pathname, options, perAttemptTimeoutMs, attempt);
      return result;
    } catch (err) {
      lastError = err;
      const status = err.status ?? 0;
      const retryAfter = err.retryAfter;

      // Non-retryable: 4xx except 408/409/425/429
      if (!isRetryableStatus(status)) {
        throw lastError;
      }

      // Check total elapsed budget before sleeping
      if (Date.now() - startTime >= maxElapsedMs) {
        throw lastError;
      }

      // Rate-limited: sleep then retry
      const delay = retryDelayMs({ headers: { get: () => retryAfter } }, attempt);
      await sleep(delay);
    }
  }

  // Exhausted attempts
  throw lastError;
}

/**
 * Core fetch logic for agentMeridianJson (no retry loop).
 * @param {string} pathname
 * @param {object} options
 * @param {number} [timeoutMs]
 * @param {number} [attempt]
 * @returns {Promise<object>}
 */
async function agentMeridianFetch(pathname, options = {}, timeoutMs, attempt) {
  const url = `${getAgentMeridianBase()}${pathname}`;
  const { retry: _retry, ...fetchOptions } = options;

  const headers = {
    ...getAgentMeridianHeaders({ json: fetchOptions.body != null }),
    ...(fetchOptions.headers || {}),
  };

  const res = timeoutMs
    ? await fetchWithTimeout(url, { ...fetchOptions, headers }, timeoutMs)
    : await fetch(url, { ...fetchOptions, headers });

  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    const err = new Error(payload?.error || `${pathname} ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    err.retryAfter = retryAfter;
    throw err;
  }

  return payload;
}

/**
 * Convenience wrapper — agentMeridianJson with a sensible default retry config.
 * Uses the same retry semantics as agentMeridianJson with options.retry set.
 *
 * @param {string} pathname
 * @param {object} [options]
 * @param {object} [retryConfig] — overrides defaults (maxAttempts, maxElapsedMs, perAttemptTimeoutMs)
 */
export async function agentMeridianJsonWithRetry(pathname, options = {}, retryConfig = {}) {
  return agentMeridianJson(pathname, {
    ...options,
    retry: {
      maxAttempts: retryConfig.maxAttempts ?? 10,
      maxElapsedMs: retryConfig.maxElapsedMs ?? 30_000,
      perAttemptTimeoutMs: retryConfig.perAttemptTimeoutMs ?? 10_000,
      ...(retryConfig ?? {}),
    },
  });
}

// ─── Relay timeouts ────────────────────────────────────────────────
const RELAY_TIMEOUT_MS = 5_000;

/**
 * Fetch open positions for a wallet from Agent Meridian relay (LPAgent-backed).
 * @param {string} wallet_address
 * @returns {Promise<Array>} Array of position objects, or [] on failure/timeout
 */
export async function agentMeridianPositions(wallet_address) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
    const data = await agentMeridianJson(
      `/positions/${wallet_address}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    // Normalize: relay may return { positions: [...] } or a raw array
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.positions)) return data.positions;
    return [];
  } catch (err) {
    // Relay unavailable or timed out — caller should fall back to Meteora
    return null;
  }
}

/**
 * Fetch PnL data for a single position from Agent Meridian relay.
 * @param {Object} opts
 * @param {string} opts.position_address
 * @param {string} [opts.pool_address] - optional, passed as query param
 * @returns {Promise<Object|null>} PnL object, or null on failure/timeout
 */
export async function agentMeridianPnl({ position_address, pool_address }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
    const qs = pool_address ? `?pool_address=${pool_address}` : "";
    const data = await agentMeridianJson(
      `/pnl/${position_address}${qs}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  } catch (err) {
    // Relay unavailable or timed out — caller should fall back to Meteora
    return null;
  }
}
