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
  try {
    return { args: JSON.parse(rawArgs), repaired: false };
  } catch (e) {
    log("debug", "agent", `JSON.parse failed for ${functionName}: ${e?.message}`);
    try {
      const repaired = JSON.parse(jsonrepair(rawArgs));
      log("warn", "agent", `Repaired malformed JSON args for ${functionName}`);
      return { args: repaired, repaired: true };
    } catch (parseError) {
      log("error", "agent", `Could not repair JSON args for ${functionName} — cleared to {}`);
      return { args: {}, repaired: false };
    }
  }
}
