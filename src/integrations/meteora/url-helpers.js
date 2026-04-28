/**
 * Meteora DLMM API URL helpers.
 * Centralizes base URL construction to avoid duplication across meteora/*.js files.
 */

const METEORA_DLMM_API_BASE = process.env.METEORA_DLMM_API_BASE || "https://dlmm.datapi.meteora.ag";

/** Position PnL URL (open or closed status) */
export function positionPnlUrl(poolAddress, walletAddress, status = "open", pageSize = 100, page = 1) {
  return `${METEORA_DLMM_API_BASE}/positions/${poolAddress}/pnl?user=${walletAddress}&status=${status}&pageSize=${pageSize}&page=${page}`;
}

/** Portfolio open positions URL */
export function portfolioUrl(walletAddress) {
  return `${METEORA_DLMM_API_BASE}/portfolio/open?user=${walletAddress}`;
}

/** Pool search URL */
export function poolSearchUrl(query) {
  return `${METEORA_DLMM_API_BASE}/pools?query=${encodeURIComponent(query)}`;
}
