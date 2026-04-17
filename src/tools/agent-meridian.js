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

const DEFAULT_BASE = "https://api.agentmeridian.xyz/api";

export function getAgentMeridianBase() {
  // Support: api.url (new flat), hive.url (hive nested), hiveMind.url (legacy)
  const url = config.api?.url || config.hiveMind?.url || DEFAULT_BASE;
  return String(url).replace(/\/+$/, "");
}

export function getAgentMeridianHeaders({ json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  // Support both flat publicApiKey and nested hive.apiKey (user-config.json uses hive.apiKey)
  const key = config.api?.publicApiKey || config.hiveMind?.apiKey;
  if (key) headers["x-api-key"] = key;
  return headers;
}

export function getAgentIdForRequests() {
  return config.hiveMind?.agentId || "agent-local";
}

export async function agentMeridianJson(pathname, options = {}) {
  const res = await fetch(`${getAgentMeridianBase()}${pathname}`, {
    ...options,
    headers: {
      ...getAgentMeridianHeaders({ json: options.body != null }),
      ...(options.headers || {}),
    },
  });
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(payload?.error || `${pathname} ${res.status}`);
  }
  return payload;
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
