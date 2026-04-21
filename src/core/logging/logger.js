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
// Console-only level: defaults to warn (errors + warnings only).
// Set CONSOLE_LOG_LEVEL=debug for full console output, or any of debug/info/warn/error.
// File output always captures everything regardless of this setting.
const CONSOLE_LEVEL = LEVELS[process.env.CONSOLE_LOG_LEVEL] ?? LEVELS.warn;
const currentLevel = LEVELS[LOG_LEVEL] || 1;

/**
 * General log function with explicit level.
 * Console output: filtered by CONSOLE_LOG_LEVEL (default: warn — errors+warnings only).
 * File output: always captures everything (filtered by LOG_LEVEL).
 * warn+ console output includes caller file:line for fast debugging.
 */
export function log(level, category, message, meta = {}) {
  const levelVal = LEVELS[level] ?? LEVELS.debug;

  const shouldConsole = levelVal >= CONSOLE_LEVEL;
  const shouldFile = levelVal >= currentLevel;
  if (!shouldConsole && !shouldFile) return;

  const timestamp = new Date().toISOString();
  const corrId = meta.correlationId ? ` [${addrShort(meta.correlationId)}]` : "";

  // Caller context for warn+ console — strip noise, keep filename + line number
  let caller = "";
  if (shouldConsole && levelVal >= LEVELS.warn) {
    const err = new Error();
    const stack = err.stack.split("\n");
    for (const line of stack.slice(2)) {
      const m = line.match(/\(([^)]+)\)/) || line.match(/at\s+([^ ]+)/);
      if (m && !m[1].includes("logger.js")) {
        const urlOrPath = m[1];
        let file;
        if (urlOrPath.startsWith("file://")) {
          file = urlOrPath.split("/").pop().split(":")[0];
        } else if (urlOrPath.includes("\\")) {
          file = urlOrPath.split("\\").pop().split(":")[0];
        } else {
          file = urlOrPath.split("/").pop().split(":")[0];
        }
        const lineNum = parts[parts.length - 2];
        caller = ` <${file}:${lineNum}>`;
        break;
      }
    }
  }

  const line = `[${timestamp}] [${category.toUpperCase()}]${corrId}${caller} ${message}`;

  if (JSON_FORMAT) {
    const entry = {
      ts: timestamp,
      level,
      msg: message,
      meta: { category: category.toUpperCase(), ...meta },
    };
    const json = JSON.stringify(entry);
    if (shouldConsole) console.log(json);
    if (shouldFile) {
      const dateStr = timestamp.split("T")[0];
      const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
      rotateIfNeeded(logFile);
      fs.appendFileSync(logFile, json + "\n");
      if (level === "error") {
        const errorFile = path.join(LOG_DIR, `errors-${dateStr}.log`);
        rotateIfNeeded(errorFile);
        fs.appendFileSync(errorFile, json + "\n");
      }
    }
    return;
  }

  // Human-readable text output
  if (shouldConsole) console.log(line);

  if (shouldFile) {
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