import { config } from "../../config.js";
import { getWalletBalances, getMintBalance } from "./balances.js";
import { swapToken } from "./swaps.js";
import { normalizeMint } from "./normalize.js";
import { addrShort } from "../../tools/addrShort.js";
import { log } from "../../core/logger.js";

/**
 * Automatically swap non-SOL tokens (fees or closed principal) to SOL.
 * If mints are provided, only those are checked. Otherwise all non-SOL tokens
 * with USD value >= $0.10 are swapped via Jupiter.
 * @param {string[]|null} [mints=null] - Specific mints to swap, or null to auto-detect
 * @returns {Promise<Object>} { success, swapped: [{ success, tx, ... }, ...] } or { success: false, error }
 */
export async function autoSwapRewardFees(mints = null) {
  try {
    const balances = await getWalletBalances();
    const solMint = normalizeMint(config.tokens.SOL);

    let tokensToSwap = balances.tokens?.filter(t =>
      normalizeMint(t.mint) !== solMint &&
      (mints === null || mints.includes(t.mint)) &&
      t.usd >= 0.10
    );

    // ─── Direct Fallback for provided mints (Helius lag or stale balance) ─────
    if (mints && mints.length > 0) {
      // Always check on-chain balance directly for provided mints — Helius may be stale
      log("info", "wallet", `Checking direct on-chain balance for ${mints.length} mint(s) due to Helius lag or stale index...`);
      for (const mint of mints) {
        if (mint === normalizeMint(config.tokens.SOL)) continue;
        const bal = await getMintBalance(mint);
        const existing = tokensToSwap.find(t => normalizeMint(t.mint) === normalizeMint(mint));
        if (bal > 0 && !existing) {
          // On-chain has balance but Helius didn't show it (lag) — add it
          tokensToSwap.push({ mint, balance: bal, symbol: addrShort(mint), usd: 1.0 });
          log("info", "wallet", `Direct balance found for ${addrShort(mint)}: ${bal} (Helius was stale/missing)`);
        } else if (bal > 0 && existing) {
          // On-chain has balance AND Helius showed it — trust on-chain for actual balance
          existing.balance = bal;
          existing.usd = 1.0; // treat as >= $0.10 so filter passes
          log("info", "wallet", `Updated balance for ${addrShort(mint)} from on-chain: ${bal} (replaced Helius stale)`);
        } else if (existing && bal === 0) {
          // Helius showed balance but on-chain is 0 — Helius is stale, remove it
          tokensToSwap = tokensToSwap.filter(t => normalizeMint(t.mint) !== normalizeMint(mint));
          log("info", "wallet", `Removed stale Helius entry for ${addrShort(mint)}: on-chain balance is 0`);
        }
      }
    }

    if (!tokensToSwap || tokensToSwap.length === 0) {
      log("info", "wallet", "No tokens found to auto-swap.");
      return { success: true, swapped: [] };
    }

    const swapResults = [];
    for (const token of tokensToSwap) {
      log("info", "wallet", `Auto-swapping token ${token.symbol || addrShort(token.mint)} (${token.balance}) to SOL`);
      const result = await swapToken({
        input_mint: token.mint,
        output_mint: config.tokens.SOL,
        amount: token.balance,
      });
      swapResults.push(result);
    }
    return { success: true, swapped: swapResults };
  } catch (e) {
    log("error", "wallet", `Auto-swap failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Sweeps all tokens in the wallet back to SOL (manual command).
 */
export async function swapAllTokensToSol() {
  log("info", "wallet", "Manual 'Swap All' triggered — sweeping wallet to SOL...");
  return await autoSwapRewardFees(null);
}