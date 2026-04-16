/**
 * Core ReAct agent loop.
 */

import { captureError } from "../instrument.js";
import { log } from "../core/logger.js";
import { config } from "../config.js";
import { getWalletBalances } from "../integrations/helius.js";
import { getMyPositions } from "../integrations/meteora.js";
import { buildSystemPrompt } from "../prompt.js";
import { getToolsForRole } from "./tools.js";
import { shouldRequireRealToolUse } from "./intent.js";
import { client, callWithRetry } from "./fallback.js";
import { DEFAULT_MODEL } from "./intent.js";
import { parseToolArgs } from "./repair.js";
import { isRateLimitError, rateLimitBackoff, sleep } from "./rate.js";
import { executeTool } from "../tools/executor.js";
import { caveman } from "../tools/caveman.js";
import { getStateSummary } from "../core/state/index.js";
import { getLessonsForPrompt, getPerformanceSummary } from "../core/lessons.js";
import { LOOP_TIMEOUT_MS } from "../core/constants.js";

// ReAct safety guards
const MAX_REACT_DEPTH = 6;
const MAX_TOOL_CALLS_PER_STEP = 10;

// Tools that should only fire once per session
const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
// These lock after first attempt regardless of outcome
const NO_RETRY_TOOLS = new Set(["deploy_position"]);

export async function agentLoop(goal, maxSteps = null, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const effectiveMaxSteps = maxSteps ?? (
    agentType === "SCREENER" ? config.llm.screenerMaxSteps ?? 5
    : agentType === "MANAGER" ? config.llm.managerMaxSteps ?? 4
    : config.llm.maxSteps ?? 10
  );
  const { requireTool = false, portfolio: prePortfolio, positions: prePositions } = options;

  const [portfolio, positions] = agentType === "SCREENER"
    ? [{ sol: "see goal" }, { positions: [] }]
    : await Promise.all([
        prePortfolio || getWalletBalances(),
        prePositions || getMyPositions()
      ]);

  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  let systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);
  let goalText = goal;

  // Caveman compression — always on
  systemPrompt = caveman(systemPrompt);
  goalText = caveman(goal);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goalText },
  ];

  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, requireTool);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  let rateLimitRetryCount = 0;
  const loopStartedAt = Date.now();

  for (let step = 0; step < effectiveMaxSteps; step++) {
    const elapsed = Date.now() - loopStartedAt;
    if (elapsed > LOOP_TIMEOUT_MS) {
      log("warn", "agent", `Wall-clock timeout reached (${Math.round(elapsed / 1000)}s > 120s) — aborting loop`);
      throw new Error("Agent loop timeout");
    }
    if (step >= MAX_REACT_DEPTH) {
      log("warn", "agent", `MAX_REACT_DEPTH (${MAX_REACT_DEPTH}) reached — aborting`);
      break;
    }
    log("info", "agent", `Step ${step + 1}/${effectiveMaxSteps}`);

    try {
      const tools = getToolsForRole(agentType, goal);
      const options = { maxTokens: maxOutputTokens };
      const { response, usedModel } = await callWithRetry(client, model, messages, tools, options);
      if (!response?.choices?.length) {
        log("error", "agent", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response?.error?.message || JSON.stringify(response)}`);
      }

      const usage = response.usage;
      if (usage) {
        log("info", "token_usage", JSON.stringify({
          role: agentType,
          steps: step,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          model: usedModel,
        }));
      }

      const msg = response.choices[0].message;

      // Repair malformed tool call JSON before pushing to history
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            const { args } = parseToolArgs(tc.function.arguments, tc.function?.name);
            tc.function.arguments = JSON.stringify(args);
          }
        }
      }
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content) {
          messages.pop();
          log("info", "agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("info", "agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: "system",
            content: "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("info", "agent", "Final answer reached");
        log("info", "agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      const toolCallsThisStep = msg.tool_calls.length;
      if (toolCallsThisStep > MAX_TOOL_CALLS_PER_STEP) {
        log("warn", "agent", `Tool call overflow in step ${step} (${toolCallsThisStep} > ${MAX_TOOL_CALLS_PER_STEP}) — aborting`);
        break;
      }

      const results = await Promise.allSettled(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        const rawArgs = toolCall.function.arguments ?? "{}";
        const { args } = parseToolArgs(rawArgs, functionName);

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("info", "agent", `Blocked duplicate ${functionName} call — already executed this session`);
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry.` }),
          };
        }

        const result = await executeTool(functionName, args);

        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));
      // Log any rejections
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          log("error", "agent", `Tool call ${i} failed`, { reason: r.reason?.message });
        }
      });
      const toolResults = results.map(r => r.status === 'fulfilled' ? r.value : {
        role: "tool",
        tool_call_id: msg.tool_calls[results.indexOf(r)].id,
        content: JSON.stringify({ error: r.reason?.message || "Tool call rejected" }),
      });

      messages.push(...toolResults);
    } catch (error) {
      log("error", "agent", `Agent loop error at step ${step}: ${error.message}`);
      captureError(error, { phase: "agent_loop", step, agentType });

      if (isRateLimitError(error)) {
        rateLimitRetryCount++;
        const backoffMs = rateLimitBackoff(rateLimitRetryCount);
        log("info", "agent", `Rate limited (429). Backing off ${backoffMs / 1000}s before retry (attempt ${rateLimitRetryCount})...`);
        if (rateLimitRetryCount >= 3) {
          throw new Error("Rate limited 3 times consecutively — aborting agent loop");
        }
        if (step >= MAX_REACT_DEPTH) {
          log("error", "agent", "Max react depth exceeded, breaking");
          break;
        }
        await sleep(backoffMs);
        continue;
      }

      log("error", "agent", `Non-retryable agent error: ${error.message}`);
      return { content: `Agent error: ${error.message}`, userMessage: goal };
    }
  }

  log("info", "agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}
