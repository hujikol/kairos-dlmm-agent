/**
 * GMGN API integration — Phase 1 foundation.
 * Auth: API key from env var (GMGN_API_KEY).
 * All functions return null until auth is configured.
 */

const GMGN_BASE_URL = "https://api.gmgn.ai";

function gmgnAuthConfigured() {
  const key = process.env.GMGN_API_KEY;
  return key != null && key !== "";
}

// ─── Public API stubs ────────────────────────────────────────────────

/**
 * Get portfolio positions for a wallet.
 * @param {string} walletAddress
 * @returns {Promise<Array|null>} null if auth not configured or error
 */
function gmgnHeaders() {
  return {
    "x-api-key": process.env.GMGN_API_KEY,
    "Content-Type": "application/json",
  };
}

export async function getPortfolio(walletAddress) {
  if (!gmgnAuthConfigured()) return null;
  try {
    const res = await fetch(`${GMGN_BASE_URL}/v1/portfolio/${walletAddress}`, {
      headers: gmgnHeaders(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.positions ?? null;
  } catch {
    return null;
  }
}

/**
 * Get token holder count and top holders.
 * @param {string} mint
 * @returns {Promise<Array|null>} null if auth not configured or error
 */
export async function getTokenHolders(mint) {
  if (!gmgnAuthConfigured()) return null;
  try {
    const res = await fetch(`${GMGN_BASE_URL}/v1/token/${mint}/holders`, {
      headers: gmgnHeaders(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.holders ?? null;
  } catch {
    return null;
  }
}

/**
 * Get current token price.
 * @param {string} mint
 * @returns {Promise<number|null>} null if auth not configured or error
 */
export async function getTokenPrice(mint) {
  if (!gmgnAuthConfigured()) return null;
  try {
    const res = await fetch(`${GMGN_BASE_URL}/v1/token/${mint}/price`, {
      headers: gmgnHeaders(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.price ?? null;
  } catch {
    return null;
  }
}

/**
 * Get OHLCV candles for a token.
 * @param {string} mint
 * @param {string} interval - "1m"|"5m"|"1h"|"1d"
 * @returns {Promise<Array|null>} null if auth not configured or error
 */
export async function getCandles(mint, interval) {
  if (!gmgnAuthConfigured()) return null;
  try {
    const res = await fetch(
      `${GMGN_BASE_URL}/v1/token/${mint}/candles?interval=${encodeURIComponent(interval)}`,
      { headers: gmgnHeaders() },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.candles ?? null;
  } catch {
    return null;
  }
}

/**
 * Get swap quote.
 * @param {string} inputMint
 * @param {string} outputMint
 * @param {string|number} amount
 * @param {number} slippage - basis points
 * @returns {Promise<Object|null>} null if auth not configured or error
 */
export async function getSwapQuote(inputMint, outputMint, amount, slippage) {
  if (!gmgnAuthConfigured()) return null;
  try {
    const res = await fetch(`${GMGN_BASE_URL}/v1/swap/quote`, {
      method: "POST",
      headers: gmgnHeaders(),
      body: JSON.stringify({ inputMint, outputMint, amount, slippage }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get swap status by transaction hash.
 * @param {string} txHash
 * @returns {Promise<Object|null>} null if auth not configured or error
 */
export async function getSwapStatus(txHash) {
  if (!gmgnAuthConfigured()) return null;
  try {
    const res = await fetch(`${GMGN_BASE_URL}/v1/swap/${txHash}/status`, {
      headers: gmgnHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
