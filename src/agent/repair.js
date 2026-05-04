/**
 * JSON repair — fixes malformed tool call arguments from LLM responses.
 */

import { jsonrepair } from "jsonrepair";
import { log } from "../core/logger.js";

/**
 * Parse tool call arguments, repairing malformed JSON on failure.
 * Returns { args, repaired } where repaired is true if jsonrepair was used.
 */
export function parseToolArgs(rawArgs, functionName) {
  let str = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
  try {
    const parsed = JSON.parse(str);
    // Non-object primitive (bool/number/etc) means model passed bare value — treat as empty
    if (parsed !== null && typeof parsed !== "object") {
      log("debug", "agent", `${functionName}: bare primitive ${typeof parsed}, treating as {}`);
      return { args: {}, repaired: false };
    }
    return { args: parsed, repaired: false };
  } catch (e) {
    log("debug", "agent", `JSON.parse failed for ${functionName}: ${e?.message}`);
    try {
      const repaired = JSON.parse(jsonrepair(str));
      log("warn", "agent", `Repaired malformed JSON args for ${functionName}`);
      return { args: repaired, repaired: true };
    } catch {
      return { args: {}, repaired: false };
    }
  }
}
