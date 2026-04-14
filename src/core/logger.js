import fs from "fs";
import path from "path";
import { addrShort } from "../tools/addrShort.js";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const JSON_FORMAT = process.env.JSON_FORMAT === "true"; // when true, output structured JSON
// ─── Log rotation ───────────────────────────────────────────────────────
// LOG_MAX_SIZE_BYTES: rotate when log exceeds this size (10 MB default).
// LOG_MAX_FILES: number of rotated .1/.2/… files to preserve before pruning.
const LOG_MAX_SIZE_BYTES = parseInt(process.env.LOG_MAX_SIZE || "10000000", 10); // 10 MB
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES || "7", 10);

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Rotate a log file if it exceeds the size threshold.
 * Rename current file to .1, .2, ... up to LOG_MAX_FILES, then truncate current.
 */
function rotateLog(logFile) {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size < LOG_MAX_SIZE_BYTES) return;

    // Prune oldest
    const base = logFile.replace(/\.\d+$/, "");
    const oldest = base + "." + LOG_MAX_FILES;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    // Shift existing rotations
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
      const src = base + "." + i;
      const dst = base + "." + (i + 1);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }

    // Rotate current to .1
    fs.renameSync(logFile, base + ".1");
    // Truncate current file
    fs.writeFileSync(logFile, "");
  } catch (err) {
    log("error", "logger", `Log rotation failed: ${err.message}`);
  }
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
  const corrId = meta.correlationId ? ` [${addrShort(meta.correlationId)}]` : "";

  // Structured JSON output
  if (JSON_FORMAT) {
    const entry = {
      ts: timestamp,
      level,
      msg: message,
      meta: { category: category.toUpperCase(), ...meta },
    };
    const json = JSON.stringify(entry);
    console.log(json);
    const dateStr = timestamp.split("T")[0];
    const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
    rotateLog(logFile);
    fs.appendFileSync(logFile, json + "\n");
    if (level === "error") {
      const errorFile = path.join(LOG_DIR, `errors-${dateStr}.log`);
      rotateLog(errorFile);
      fs.appendFileSync(errorFile, json + "\n");
    }
    return;
  }

  // Human-readable text output (default)
  const line = `[${timestamp}] [${category.toUpperCase()}]${corrId} ${message}`;
  console.log(line);

  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  rotateLog(logFile);
  fs.appendFileSync(logFile, line + "\n");

  if (level === "error") {
    const errorFile = path.join(LOG_DIR, `errors-${dateStr}.log`);
    rotateLog(errorFile);
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
    case "deploy_position":   return ` ${a.pool_name || addrShort(a.pool_address)} ${a.amount_sol} SOL`;
    case "close_position":    return ` ${addrShort(a.position_address)}${r.pnl_usd != null ? ` | PnL $${r.pnl_usd >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${addrShort(a.position_address)}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || addrShort(a.pool_address) || ""}`;
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
  rotateLog(actionsFile);
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
  rotateLog(snapshotFile);
  fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
}
