/**
 * Tool filtering by role — MANAGER, SCREENER, GENERAL.
 * GENERAL role uses intent classification to narrow the tool set.
 */

import { ALL_TOOLS as tools } from "../tools/definitions.js";
import { INTENT_PATTERNS, INTENT_TOOLS } from "./intent.js";

export const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "update_config", "get_position_pnl", "get_my_positions", "set_position_note", "add_pool_note", "get_wallet_balance", "get_wallet_positions"]);
export const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "add_pool_note", "add_to_blacklist", "update_config", "get_wallet_balance", "get_my_positions", "get_wallet_positions"]);

function makeStrictSchema(schema) {
  if (schema.type === "object" && schema.properties) {
    schema.additionalProperties = false;
    const origRequired = new Set(schema.required || []);
    schema.required = Object.keys(schema.properties);
    for (const key of schema.required) {
      const prop = schema.properties[key];
      if (!origRequired.has(key)) {
        if (typeof prop.type === "string") {
          prop.type = [prop.type, "null"];
        } else if (Array.isArray(prop.type)) {
          if (!prop.type.includes("null")) prop.type.push("null");
        }
      }
      makeStrictSchema(prop);
    }
  } else if (schema.type === "array" && schema.items) {
    makeStrictSchema(schema.items);
  }
}

export function getToolsForRole(agentType, goal = "") {
  let matchedTools;
  if (agentType === "MANAGER")  matchedTools = tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  else if (agentType === "SCREENER") matchedTools = tools.filter(t => SCREENER_TOOLS.has(t.function.name));
  else {
    const matched = new Set();
    for (const { intent, re } of INTENT_PATTERNS) {
      if (re.test(goal)) {
        for (const t of INTENT_TOOLS[intent]) matched.add(t);
      }
    }
    // Fall back to all tools if no intent matched
    matchedTools = matched.size === 0 ? tools : tools.filter(t => matched.has(t.function.name));
  }

  // Enforce strict output schema formatting dynamically
  return matchedTools.map(t => {
    const tc = JSON.parse(JSON.stringify(t));
    tc.function.strict = true;
    if (tc.function.parameters) {
      makeStrictSchema(tc.function.parameters);
    } else {
      tc.function.parameters = { type: "object", properties: {}, additionalProperties: false };
    }
    return tc;
  });
}
