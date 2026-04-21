import { log, logAction } from "../core/logger.js";
import { BALANCE_CACHE_AGE_MS } from "../core/constants.js";
import { cachedTool } from "./cache.js";
import { registerCronRestarter as _registerCron } from "./admin.js";
export const registerCronRestarter = _registerCron;

// Register all tool domains
import { registerScreens } from "./screens.js";
import { registerTokens } from "./tokens.js";
import { registerPositions, positionWriteTools } from "./positions.js";
import { registerWallet, walletWriteTools } from "./wallet.js";
import { registerAdmin } from "./admin.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

const toolMap = {};
function registerTool(name, fn) { toolMap[name] = fn; }
registerScreens(registerTool);
registerTokens(registerTool);
registerPositions(registerTool);
registerWallet(registerTool);
registerAdmin(registerTool);

// All write tools that need safety checks
const WRITE_TOOLS = new Set([...positionWriteTools, ...walletWriteTools]);

// Read-only tools that can use the TTL cache.
// Map of tool name → cache key extractor function (receives args, returns string key)
const READ_ONLY_CACHE = {
  discover_pools:      () => "default",
  get_top_candidates:  () => "default",
  get_pool_detail:     (a) => a.pool_address || "default",
  get_active_bin:      (a) => a.pool_address || "default",
  get_position_pnl:   (a) => a.position_address || "default",
  get_my_positions:   () => "default",
  get_balances:        () => "default",
  get_wallet_balance: () => "default",
  token_info:         (a) => a.mint || "default",
  token_holders:      (a) => a.mint || "default",
  search_pools:        (a) => a.query || "default",
};

export { toolMap };

/**
 * Validate tool arguments against the tool's parameter schema.
 * Throws a descriptive error if required params are missing or extra params are present.
 */
function validateToolArgs(toolName, args, schema) {
  if (!schema || typeof args !== "object" || args === null) return;

  const required = schema.required || [];
  for (const param of required) {
    if (!(param in args) || args[param] === undefined) {
      throw new Error(`Missing required param '${param}' for '${toolName}' tool`);
    }
  }

  if (schema.additionalProperties === false && args) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        throw new Error(`Unknown param '${key}' for '${toolName}' tool — additionalProperties: false`);
      }
    }
  }
}

/**
 * Execute a tool call with safety checks and logging.
 * Read-only tools use the TTL cache to avoid redundant API calls.
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

  // ─── Execute (cached for read-only tools) ─────────────────────
  try {
    // ─── Runtime argument validation ─────────────────────────────
    const schema = TOOL_DEFINITIONS[name];
    if (schema) validateToolArgs(name, args, schema);

    const doExec = () => fn(args);
    const cached = READ_ONLY_CACHE[name];
    const result = cached
      ? await cachedTool(name, cached(args), doExec)
      : await doExec();
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

      // Guard against absurd amount_x values (LLM hallucination)
      if (args.amount_x != null && args.amount_x > 1e11) {
        return { pass: false, reason: `amount_x ${args.amount_x} is absurdly large — LLM likely hallucinated. Provide only amount_y (SOL) and let the protocol compute amount_x.` };
      }

      // ─── Token-only deploy check (before any mutation — must use original args) ─
      // Token-only = user provides amount_x with SOL amount explicitly set to 0 (or omitted)
      const isTokenOnly = args.amount_x != null && args.amount_x > 0 && (args.amount_y == null || args.amount_y === 0);

      // Fetch balance for conviction sizing
      const balanceAgeMs = getBalanceCacheAgeMs();
      const balance = balanceAgeMs !== null && balanceAgeMs < BALANCE_CACHE_AGE_MS
        ? getCachedBalance()
        : await getWalletBalances();

      // bid_ask is one-sided — bins_above must be 0 and amount_x must be 0
      const effectiveStrategy = args.strategy || config.strategy.strategy;
      if (effectiveStrategy === "bid_ask") {
        if (args.bins_above != null && args.bins_above > 0) {
          return { pass: false, reason: `bid_ask strategy is one-sided — bins_above must be 0, got ${args.bins_above}.` };
        }
        // Token-only deploys can have amount_x > 0 (user explicitly requested token-side)
        if (!isTokenOnly) args.amount_x = 0;
      }

      // ─── Conviction Sizing Matrix ──────────────────────────────
      const { computeDeployAmount } = await import("../config.js");
      const conviction = args.conviction || "normal";

      // Token-only deploys skip conviction sizing and SOL balance check
      if (!isTokenOnly) {
        const sizingResult = computeDeployAmount(balance.sol, positions.total_positions, conviction);
        if (sizingResult.error) {
          return { pass: false, reason: sizingResult.error };
        }
        const amountY = sizingResult.amount;
        args.amount_y = amountY;
        if (args.amount_sol) args.amount_sol = amountY;
        log("info", "conviction_sizing", `Conviction: ${conviction} | Positions: ${positions.total_positions} | Deploy: ${amountY} SOL (wallet: ${balance.sol.toFixed(2)} SOL)`);

        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return { pass: false, reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).` };
        }
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
