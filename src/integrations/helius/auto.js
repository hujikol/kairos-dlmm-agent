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

    // ─── Direct Fallback for provided mints (Helius lag) ───────
    if (mints && mints.length > 0) {
      const foundMints = new Set(tokensToSwap.map(t => t.mint));
      const missingMints = mints.filter(m => !foundMints.has(m) && m !== config.tokens.SOL);

      if (missingMints.length > 0) {
        log("info", "wallet", `Checking direct balance for ${missingMints.length} missing mint(s) due to Helius API lag...`);
        for (const mint of missingMints) {
          const bal = await getMintBalance(mint);
          if (bal > 0) {
            // usd=1.0 is a Helius placeholder — only set when balance > 0 (skip dust/zero-value tokens)
            tokensToSwap.push({ mint, balance: bal, symbol: addrShort(mint), usd: bal > 0 ? 1.0 : 0 });
          } else {
            log("info", "wallet", `Skipped ${addrShort(mint)}: Direct balance is 0.`);
          }
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