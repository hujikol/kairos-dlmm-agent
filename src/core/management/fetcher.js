/**
 * Fetcher module — fetch positions and balances for management cycle.
 */

import { getMyPositions } from "../../integrations/meteora.js";
import { getWalletBalances } from "../../integrations/helius.js";
import { log } from "../../core/logger.js";

/**
 * Fetch live positions with force refresh.
 * @returns {Promise<Array>} positions array
 */
export async function fetchPositions() {
  try {
    const result = await getMyPositions({ force: true });
    return result?.positions || [];
  } catch (e) {
    log("warn", "management:fetcher", `getMyPositions failed: ${e?.message ?? e}`);
    return [];
  }
}

/**
 * Fetch current wallet balances.
 * @returns {Promise<Object>} balance data { sol, sol_usd, tokens, total_usd }
 */
export async function fetchBalances() {
  try {
    return await getWalletBalances();
  } catch (e) {
    log("warn", "management:fetcher", `getWalletBalances failed: ${e?.message ?? e}`);
    return { sol: 0, sol_usd: 0, tokens: [], total_usd: 0 };
  }
}

/**
 * Fetch both positions and balances in parallel.
 * @returns {Promise<[Array, Object]>} [positions, balances]
 */
export async function fetchAll() {
  return Promise.all([fetchPositions(), fetchBalances()]);
}
