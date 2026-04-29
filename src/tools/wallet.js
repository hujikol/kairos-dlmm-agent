import { getWalletBalances, swapToken, swapAllTokensToSol } from "../integrations/helius.js";
import { pushNotification } from "../notifications/queue.js";
import { SOL_MINT } from "../constants.js";
import { addrShort } from "./addrShort.js";

export const walletWriteTools = new Set(["swap_token"]);

const SWAP_SOL_ADDRESS = SOL_MINT;

export function registerWallet(registerTool) {
  registerTool("get_wallet_balance", getWalletBalances);

  registerTool("swap_token", async (args) => {
    const result = await swapToken(args);
    const success = result?.success !== false && !result?.error;
    if (success && result.tx) {
      pushNotification({
        type: "swap",
        from: addrShort(args.input_mint),
        to: args.output_mint === SWAP_SOL_ADDRESS || args.output_mint === "SOL" ? "SOL" : addrShort(args.output_mint),
        amountIn: result.amount_in,
        amountOut: result.amount_out,
        tx: result.tx,
      });
    }
    return result;
  });

  registerTool("swap_all_to_sol", swapAllTokensToSol);
}
