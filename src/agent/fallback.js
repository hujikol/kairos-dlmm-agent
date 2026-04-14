/**
 * LLM client and model fallback chain.
 * Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio).
 */

import OpenAI from "openai";
import { log } from "../core/logger.js";
import { DEFAULT_MODEL, FALLBACK_MODEL } from "./intent.js";

export const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: parseInt(process.env.LLM_TIMEOUT_MS || "300000"),
});

/**
 * Attempt an API call with up to 3 retries and model fallback on 502/503/529.
 * Returns { response, usedModel }.
 */
export async function callWithRetry(client, model, messages, tools, options = {}) {
  let usedModel = model || DEFAULT_MODEL;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.chat.completions.create({
      model: usedModel,
      messages,
      tools,
      tool_choice: options.toolChoice ?? "auto",
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    });
    if (response.choices?.length) return { response, usedModel };
    const errCode = response.error?.code;
    if (errCode === 502 || errCode === 503 || errCode === 529) {
      const wait = (attempt + 1) * 5000;
      if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
        usedModel = FALLBACK_MODEL;
        log("info", "agent", `Switching to fallback model ${FALLBACK_MODEL}`);
      } else {
        log("info", "agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } else {
      break;
    }
  }
  return { response: null, usedModel };
}
