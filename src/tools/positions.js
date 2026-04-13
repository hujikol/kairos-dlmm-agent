import { deployPosition, getMyPositions, getWalletPositions, getPositionPnl, closePosition, claimFees } from "../integrations/meteora.js";
import { autoSwapRewardFees } from "../integrations/helius.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../features/token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../features/dev-blocklist.js";
import { addPoolNote, getPoolMemory } from "../features/pool-memory.js";
import { config } from "../config.js";
import { log, logAction } from "../core/logger.js";
import { pushNotification } from "../notifications/queue.js";
import { setPositionInstruction } from "../core/state.js";
import { addrShort } from "./addrShort.js";

export const positionWriteTools = new Set([
  "deploy_position",
  "close_position",
]);

export function registerPositions(registerTool) {
  registerTool("get_position_pnl", getPositionPnl);
  registerTool("get_my_positions", getMyPositions);
  registerTool("get_wallet_positions", getWalletPositions);
  registerTool("set_position_note", ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  });

  registerTool("claim_fees", async (args) => {
    const result = await claimFees(args);
    if (result?.success !== false && !result?.error && config.management.autoSwapAfterClaim && result.base_mint) {
      try {
        const mintsToSwap = [result.base_mint];
        if (result.quote_mint) mintsToSwap.push(result.quote_mint);
        await autoSwapRewardFees(mintsToSwap);
      } catch (e) {
        log("warn", "executor", `Auto-swap after claim failed: ${e.message}`);
      }
    }
    return result;
  });

  registerTool("close_position", async (args) => {
    const result = await closePosition(args);
    const success = result?.success !== false && !result?.error;
    if (success) {
      pushNotification({
        type: "close",
        pair: result.pool_name || addrShort(args.position_address),
        pnlUsd: result.pnl_usd ?? 0,
        pnlPct: result.pnl_pct ?? 0,
        reason: args.reason,
      });
      if (args.reason && args.reason.toLowerCase().includes("yield")) {
        const poolAddr = result.pool || args.pool_address;
        if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0, 10)}` }).catch?.(() => {});
      }
      if (config.management.autoSwapAfterClose && !args.skip_swap && result.base_mint) {
        try {
          const mintsToSwap = [result.base_mint];
          if (result.quote_mint) mintsToSwap.push(result.quote_mint);
          const swapResult = await autoSwapRewardFees(mintsToSwap);
          if (swapResult && swapResult.swapped && swapResult.swapped.length > 0) {
            result.auto_swapped = true;
            result.auto_swap_note = `Non-SOL tokens already auto-swapped back to SOL. Do NOT call swap_token again.`;
            result.sol_received = swapResult.swapped.reduce((acc, s) => acc + (s.amount_out || 0), 0);
          } else {
            log("info", "executor", `Auto-swap after close: No eligible tokens found to swap (or balance not yet indexed).`);
          }
        } catch (e) {
          log("warn", "executor", `Auto-swap after close failed: ${e.message}`);
        }
      }
    }
    return result;
  });

  registerTool("deploy_position", async (args) => {
    const result = await deployPosition(args);
    const success = result?.success !== false && !result?.error;
    if (success) {
      pushNotification({
        type: "deploy",
        pair: result.pool_name || args.pool_name || addrShort(args.pool_address),
        amountSol: args.amount_y ?? args.amount_sol ?? 0,
        position: result.position,
        tx: result.txs?.[0] ?? result.tx,
        priceRange: result.price_range,
        binStep: result.bin_step,
        baseFee: result.base_fee,
      });
    }
    return result;
  });

  // Blacklist / blocklist tools
  registerTool("add_to_blacklist", addToBlacklist);
  registerTool("remove_from_blacklist", removeFromBlacklist);
  registerTool("list_blacklist", listBlacklist);
  registerTool("block_deployer", blockDev);
  registerTool("unblock_deployer", unblockDev);
  registerTool("list_blocked_deployers", listBlockedDevs);

  // Pool memory
  registerTool("get_pool_memory", getPoolMemory);
  registerTool("add_pool_note", addPoolNote);
}
