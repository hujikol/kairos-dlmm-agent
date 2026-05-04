/**
 * LLM client and model fallback chain.
 * Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio).
 */

import OpenAI from "openai";
import { log } from "../core/logger.js";
import { DEFAULT_MODEL, FALLBACK_MODEL } from "./intent.js";
import { LLM_TIMEOUT_MS, RETRY_DELAY_MS } from "../core/constants.js";

// Lazy client — created on first use so module loads without API key
// Exported as a Proxy so property access triggers lazy creation
let _client = null;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
      timeout: LLM_TIMEOUT_MS,
    });
  }
  return _client;
}

export const client = new Proxy({}, {
  get(target, prop) { return getClient()[prop]; },
  set(target, prop, value) { getClient()[prop] = value; return true; },
});

/**
 * Attempt an API call with up to 3 retries and model fallback on 502/503/529.
 * Returns { response, usedModel }.
 *
 * Mutable implementation for test mockability.
 * Tests can replace _callWithRetryImpl via _setCallWithRetry.
 */
let _callWithRetryImpl = async (client, model, messages, tools, options = {}) => {
  let usedModel = model || DEFAULT_MODEL;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await getClient().chat.completions.create({
        model: usedModel,
        messages,
        tools,
        tool_choice: options.toolChoice ?? "auto",
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      });
    } catch (err) {
      log("warn", "agent", `LLM call attempt ${attempt + 1} failed: ${err?.message ?? err}. Retrying...`);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * RETRY_DELAY_MS));
        continue;
      }
      return { response: null, usedModel };
    }

    if (response.choices?.length) return { response, usedModel };

    const errCode = response.error?.code;
    if (errCode === 502 || errCode === 503 || errCode === 529) {
      const wait = (attempt + 1) * RETRY_DELAY_MS;
      if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
        usedModel = FALLBACK_MODEL;
        log("info", "agent", `Switching to fallback model ${FALLBACK_MODEL}`);
      } else {
        log("info", "agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } else if (response.error) {
      log("warn", "agent", `LLM API error: ${response.error?.message ?? response.error} (code: ${errCode ?? "unknown"}). Giving up.`);
      break;
    } else {
      log("warn", "agent", `LLM returned no choices (attempt ${attempt + 1}/3). Retrying...`);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * RETRY_DELAY_MS));
        continue;
      }
    }
  }
  return { response: null, usedModel };
};

export async function callWithRetry(client, model, messages, tools, options = {}) {
  return _callWithRetryImpl(client, model, messages, tools, options);
}

export function _setCallWithRetry(fn) {
  _callWithRetryImpl = fn;
}

const _originalCallWithRetryImpl = _callWithRetryImpl;
export function _resetCallWithRetry() {
  _callWithRetryImpl = _originalCallWithRetryImpl;
}
