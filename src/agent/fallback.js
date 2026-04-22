/**
 * LLM client and model fallback chain.
 * Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio).
 *
 * NOTE: This module uses its own LLM-specific retry with model fallback (callWithRetry).
 * The shared retry utility is in src/core/retry.js — prefer that for non-LLM retry use cases.
 */

import OpenAI from "openai";
import { log } from "../core/logger.js";
import { DEFAULT_MODEL, FALLBACK_MODEL } from "./intent.js";
import { LLM_TIMEOUT_MS, RETRY_DELAY_MS } from "../core/constants.js";

export const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: LLM_TIMEOUT_MS,
});

/**
 * Attempt an API call with up to 3 retries and model fallback on 502/503/529.
 * Returns { response, usedModel }.
 */
export async function callWithRetry(client, model, messages, tools, options = {}) {
  let usedModel = model || DEFAULT_MODEL;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model: usedModel,
        messages,
        tools,
        tool_choice: options.toolChoice ?? "auto",
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      });
    } catch (err) {
      // Network error, JSON parse failure, etc. — retry all of them
      log("warn", "agent", `LLM call attempt ${attempt + 1} failed: ${err?.message ?? err}. Retrying...`);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * RETRY_DELAY_MS));
        continue;
      }
      return { response: null, usedModel };
    }

    if (response.choices?.length) return { response, usedModel };

    // Empty choices with an error — check if it's retryable
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
      // Non-retryable API error (400, 401, 404, etc.) or malformed error object
      log("warn", "agent", `LLM API error: ${response.error?.message ?? response.error} (code: ${errCode ?? "unknown"}). Giving up.`);
      break;
    } else {
      // Empty choices with no error — unexpected but retry
      log("warn", "agent", `LLM returned no choices (attempt ${attempt + 1}/3). Retrying...`);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * RETRY_DELAY_MS));
        continue;
      }
    }
  }
  return { response: null, usedModel };
}
