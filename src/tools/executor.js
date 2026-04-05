import fs from "fs";
import writeFileAtomic from "write-file-atomic";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { log, logAction } from "../core/logger.js";
import { registerCronRestarter as _registerCron } from "./admin.js";
export const registerCronRestarter = _registerCron;

// Register all tool domains
import { registerScreens } from "./screens.js";
import { registerTokens } from "./tokens.js";
import { registerPositions, positionWriteTools } from "./positions.js";
import { registerWallet, walletWriteTools } from "./wallet.js";
import { registerAdmin } from "./admin.js";

const toolMap = {};
function registerTool(name, fn) { toolMap[name] = fn; }
registerScreens(registerTool);
registerTokens(registerTool);
registerPositions(registerTool);
registerWallet(registerTool);
registerAdmin(registerTool);

// All write tools that need safety checks
const WRITE_TOOLS = new Set([...positionWriteTools, ...walletWriteTools]);

export { toolMap };

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", "executor", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("warn", "safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return { blocked: true, reason: safetyCheck.reason };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    // Invalidate balance cache after balance-changing operations
    if (success && ["deploy_position", "close_position", "claim_fees"].includes(name)) {
      const { invalidateBalanceCache } = await import("../integrations/helius.js");
      invalidateBalanceCache();
    }

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    return { error: error.message, tool: name };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Lazy import to avoid circular dependency
      const { config } = await import("../config.js");
      const { getMyPositions } = await import("../integrations/meteora.js");
      const { getWalletBalances, getBalanceCacheAgeMs, getCachedBalance } = await import("../integrations/helius.js");

      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return { pass: false, reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].` };
      }

      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return { pass: false, reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.` };
      }
      const alreadyInPool = positions.positions.some((p) => p.pool === args.pool_address);
      if (alreadyInPool) {
        return { pass: false, reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.` };
      }

      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some((p) => p.base_mint === args.base_mint);
        if (alreadyHasMint) {
          return { pass: false, reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.` };
        }
      }

      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return { pass: false, reason: `Must provide a positive SOL amount (amount_y).` };
      }
      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return { pass: false, reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.` };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return { pass: false, reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).` };
      }

      const balanceAgeMs = getBalanceCacheAgeMs();
      const balance = balanceAgeMs !== null && balanceAgeMs < 30_000
        ? getCachedBalance()
        : await getWalletBalances();
      const gasReserve = config.management.gasReserve;
      const minRequired = amountY + gasReserve;
      if (balance.sol < minRequired) {
        return { pass: false, reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).` };
      }

      return { pass: true };
    }
    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
