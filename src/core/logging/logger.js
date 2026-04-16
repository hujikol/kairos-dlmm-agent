import fs from "fs";
import path from "path";
import { addrShort } from "../../tools/addrShort.js";
import { rotateIfNeeded } from "./rotation.js";
import { logAction } from "./action-log.js";
import { logSnapshot } from "./snapshot-log.js";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const JSON_FORMAT = process.env.JSON_FORMAT === "true";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

/**
 * General log function with explicit level.
 */
export function log(level, category, message, meta = {}) {
  if (LEVELS[level] === undefined) {
    // Unknown level — treat as debug (fallback, don't crash)
    if (LEVELS.debug < currentLevel) return;
  } else if (LEVELS[level] < currentLevel) return;

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
    rotateIfNeeded(logFile);
    fs.appendFileSync(logFile, json + "\n");
    if (level === "error") {
      const errorFile = path.join(LOG_DIR, `errors-${dateStr}.log`);
      rotateIfNeeded(errorFile);
      fs.appendFileSync(errorFile, json + "\n");
    }
    return;
  }

  // Human-readable text output (default)
  const line = `[${timestamp}] [${category.toUpperCase()}]${corrId} ${message}`;
  console.log(line);

  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  rotateIfNeeded(logFile);
  fs.appendFileSync(logFile, line + "\n");

  if (level === "error") {
    const errorFile = path.join(LOG_DIR, `errors-${dateStr}.log`);
    rotateIfNeeded(errorFile);
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

export { logAction, logSnapshot };
