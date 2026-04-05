import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * General log function with explicit level.
 */
export function log(level, category, message, meta = {}) {
  if (LEVELS[level] === undefined) {
    throw new Error(`Unknown log level: ${level}`);
  }
  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const corrId = meta.correlationId ? ` [${meta.correlationId.slice(0, 8)}]` : "";
  const line = `[${timestamp}] [${category.toUpperCase()}]${corrId} ${message}`;

  // Console output
  console.log(line);

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");

  // Separate error file
  if (level === "error") {
    const errorFile = path.join(LOG_DIR, `errors-${dateStr}.log`);
    fs.appendFileSync(errorFile, line + "\n");
  }
}

/**
 * Convenience helpers
 */
export const logInfo  = (cat, msg, meta) => log("info",  cat, msg, meta);
export const logWarn  = (cat, msg, meta) => log("warn",  cat, msg, meta);
export const logError = (cat, msgOrErr, meta) => {
  const message = msgOrErr instanceof Error && msgOrErr.stack ? msgOrErr.stack : String(msgOrErr);
  log("error", cat, message, meta);
};
export const logDebug = (cat, msg, meta) => log("debug", cat, msg, meta);

/**
 * Log a tool action with full details (for audit trail).
 */
function actionHint(action) {
  const a = action.args || {};
  const r = action.result || {};
  switch (action.tool) {
    case "deploy_position":   return ` ${a.pool_name || a.pool_address?.slice(0,8)} ${a.amount_sol} SOL`;
    case "close_position":    return ` ${a.position_address?.slice(0,8)}${r.pnl_usd != null ? ` | PnL $${r.pnl_usd >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${a.position_address?.slice(0,8)}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || a.pool_address?.slice(0,8) || ""}`;
    case "get_my_positions":  return ` ${r.total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${r.sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${r?.candidates?.length ?? ""} pools`;
    case "swap_token":        return ` ${a.amount} ${a.input_mint?.slice(0,6)}→SOL`;
    case "update_config":     return ` ${Object.keys(r.applied || {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${r.cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action) {
  const timestamp = new Date().toISOString();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
}

/**
 * Log a portfolio snapshot (for tracking performance over time).
 */
export function logSnapshot(snapshot) {
  const timestamp = new Date().toISOString();

  const entry = {
    timestamp,
    ...snapshot,
  };

  const dateStr = timestamp.split("T")[0];
  const snapshotFile = path.join(LOG_DIR, `snapshots-${dateStr}.jsonl`);
  fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
}
