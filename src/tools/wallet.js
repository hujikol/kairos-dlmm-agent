import { getWalletBalances, swapToken, swapAllTokensToSol } from "../integrations/helius.js";
import { log, logAction } from "../core/logger.js";
import { pushNotification } from "../notifications/queue.js";

export const walletWriteTools = new Set(["swap_token"]);

const SWAP_SOL_ADDRESS = "So11111111111111111111111111111111111111112";

export function registerWallet(registerTool) {
  registerTool("get_wallet_balance", getWalletBalances);

  registerTool("swap_token", async (args) => {
    const result = await swapToken(args);
    const success = result?.success !== false && !result?.error;
    if (success && result.tx) {
      pushNotification({
        type: "swap",
        from: args.input_mint?.slice(0, 8),
        to: args.output_mint === SWAP_SOL_ADDRESS || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8),
        amountIn: result.amount_in,
        amountOut: result.amount_out,
        tx: result.tx,
      });
    }
    return result;
  });

  registerTool("swap_all_to_sol", swapAllTokensToSol);
}
