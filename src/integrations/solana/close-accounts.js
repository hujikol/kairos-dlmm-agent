import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { getWallet } from "../meteora/pool.js";
import { log } from "../../core/logger.js";

/**
 * Sweep residual SOL (rent refund) from a closed DLMM position account to the main wallet.
 * @param {string} positionAddress - The on-chain position address
 * @returns {Promise<{success: boolean, amount?: number, error?: string}>}
 */
export async function claimAndSweepSol(positionAddress) {
  try {
    const conn = new Connection(process.env.RPC_URL);
    const wallet = getWallet();
    const posPubkey = new PublicKey(positionAddress);

    const accountInfo = await conn.getAccountInfo(posPubkey);
    if (!accountInfo || accountInfo.lamports === 0) {
      return { success: true, amount: 0 };
    }

    const amount = accountInfo.lamports;
    const tx = SystemProgram.transfer({
      fromPubkey: posPubkey,
      toPubkey: wallet.publicKey,
      lamports: amount,
    });

    const sig = await conn.sendTransaction(tx, [wallet]);
    await conn.confirmTransaction(sig);
    log("info", "claim-sol", `Swept ${amount} lamports from ${positionAddress.slice(0, 8)}`);
    return { success: true, amount };
  } catch (e) {
    log("warn", "claim-sol", `Failed to claim SOL: ${e.message}`);
    return { success: false, error: e.message };
  }
}
