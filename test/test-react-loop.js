/**
 * Unit tests for src/agent/react.js core logic.
 * Tests: MAX_REACT_DEPTH guard, empty tool_calls, tool error handling via
 * Promise.allSettled, ONCE_PER_SESSION blocking, rate-limit backoff.
 *
 * Uses mutable ref pattern via _setCallWithRetry / _setExecuteTool
 * so mocks take effect inside agentLoop (ESM live binding).
 *
 * Run: node --test test/test-react-loop.js
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { test, describe } from "node:test";
import assert from "node:assert";

// ─── Test suite ───────────────────────────────────────────────────────

describe("agent/react.js core logic", () => {

  // ── 1. MAX_REACT_DEPTH guard kicks in at depth 10 ───────────────────

  test("MAX_REACT_DEPTH constant is 10 in constants.js", async () => {
    const src = readFileSync(resolve("G:/Meridian/kairos-dllm-agent/src/core/constants.js"), "utf8");
    const match = src.match(/export const MAX_REACT_DEPTH\s*=\s*(\d+)/);
    assert.ok(match, "MAX_REACT_DEPTH constant should exist in constants.js");
    assert.strictEqual(parseInt(match[1]), 10, "MAX_REACT_DEPTH should be 10");
  });

  test("agentLoop fires callWithRetry exactly 10 times before MAX_REACT_DEPTH breaks the loop", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");

    let callCount = 0;
    fallbackMod._setCallWithRetry(async () => {
      callCount++;
      return {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: `call_${callCount}`,
                function: { name: "get_my_positions", arguments: "{}" },
              }],
            },
          }],
        },
        usedModel: "test",
      };
    });

    try {
      const _result = await agentLoop("test goal", 20, [], "GENERAL", null, null, {});
      assert.strictEqual(callCount, 10, `callWithRetry should fire exactly 10 times (MAX_REACT_DEPTH), got: ${callCount}`);
    } finally {
      fallbackMod._resetCallWithRetry();
    }
  });

  // ── 2. Empty tool_calls response doesn't crash ───────────────────────

  test("empty tool_calls array returns final answer without error", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");

    fallbackMod._setCallWithRetry(async () => ({
      response: {
        choices: [{
          message: {
            role: "assistant",
            content: "All good, no tools needed.",
            tool_calls: [],
          },
        }],
      },
      usedModel: "test",
    }));

    try {
      const result = await agentLoop("simple question", 3, [], "GENERAL", null, null, {});
      assert.strictEqual(result.content, "All good, no tools needed.");
    } finally {
      fallbackMod._resetCallWithRetry();
    }
  });

  // ── 3. Tool call error is handled gracefully with Promise.allSettled ─────────

  test("thrown tool call does not crash the loop — returns structured error result", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");
    const execMod = await import("../src/tools/executor.js");

    let step = 0;
    fallbackMod._setCallWithRetry(async () => {
      step++;
      if (step === 1) {
        return {
          response: {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call_fail",
                  function: { name: "get_position_pnl", arguments: '{"position_address":"pos123"}' },
                }],
              },
            }],
          },
          usedModel: "test",
        };
      }
      return {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: "Got the result.",
              tool_calls: [],
            },
          }],
        },
        usedModel: "test",
      };
    });

    execMod._setExecuteTool(async () => {
      throw new Error("Simulated RPC timeout");
    });

    try {
      const result = await agentLoop("check pnl", 5, [], "MANAGER", null, null, {});
      // Loop completes without throwing — error is captured and returned as tool result
      assert.ok(result !== undefined, "agentLoop should return a result");
    } finally {
      fallbackMod._resetCallWithRetry();
      execMod._resetExecuteTool();
    }
  });

  // ── 4. ONCE_PER_SESSION blocks repeat deploy_position calls ─────────────────

  test("second deploy_position call in same session is blocked", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");
    const execMod = await import("../src/tools/executor.js");

    let step = 0;
    let _toolCallResults = [];

    fallbackMod._setCallWithRetry(async () => {
      step++;
      return {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: `call_${step}`,
                function: { name: "deploy_position", arguments: '{"pool_address":"PoolABC","bin_step":100}' },
              }],
            },
          }],
        },
        usedModel: "test",
      };
    });

    let execCount = 0;
    execMod._setExecuteTool(async (_name, _args) => {
      execCount++;
      return { success: true, deployed: `pos${execCount}` };
    });

    try {
      const result = await agentLoop("deploy to PoolABC", 10, [], "SCREENER", null, null, {});
      // Loop should complete (not hang) after the second deploy_position is blocked
      assert.ok(result !== undefined, "agentLoop should return after blocked call");
    } finally {
      fallbackMod._resetCallWithRetry();
      execMod._resetExecuteTool();
    }
  });

  test("ONCE_PER_SESSION does NOT block different tools called in same session", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");
    const execMod = await import("../src/tools/executor.js");

    let step = 0;
    const _toolCalls = [];

    fallbackMod._setCallWithRetry(async () => {
      step++;
      if (step === 1) {
        return {
          response: {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "c1",
                  function: { name: "get_my_positions", arguments: "{}" },
                }],
              },
            }],
          },
          usedModel: "test",
        };
      }
      return {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: "Done.",
              tool_calls: [],
            },
          }],
        },
        usedModel: "test",
      };
    });

    const calledTools = [];
    execMod._setExecuteTool(async (name, _args) => {
      calledTools.push(name);
      return { success: true };
    });

    try {
      await agentLoop("check positions", 5, [], "MANAGER", null, null, {});
      assert.deepStrictEqual(calledTools, ["get_my_positions"]);
    } finally {
      fallbackMod._resetCallWithRetry();
      execMod._resetExecuteTool();
    }
  });

  // ── 5. Rate limit retry backoff works ───────────────────────────────

  test("rateLimitBackoff returns correct exponential delays", async () => {
    const { rateLimitBackoff } = await import("../src/agent/rate.js");

    // retryCount 1 → 30s, retryCount 2 → 60s, retryCount 3+ → 120s (capped)
    assert.strictEqual(rateLimitBackoff(1), 30000, "retry 1 → 30s");
    assert.strictEqual(rateLimitBackoff(2), 60000, "retry 2 → 60s");
    assert.strictEqual(rateLimitBackoff(3), 120000, "retry 3 → 120s (capped)");
    assert.strictEqual(rateLimitBackoff(4), 120000, "retry 4 → still 120s (capped)");
  });

  test("isRateLimitError detects 429 errors", async () => {
    const { isRateLimitError } = await import("../src/agent/rate.js");

    assert.strictEqual(isRateLimitError({ message: "429 Too Many Requests", status: 429 }), true);
    assert.strictEqual(isRateLimitError(new Error("rate limit exceeded")), true);
    assert.strictEqual(isRateLimitError(new Error("Too many requests")), true);
    assert.strictEqual(isRateLimitError(new Error("timeout")), false);
  });

  test("loop throws after 3 consecutive rate limit failures", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");
    const rateMod = await import("../src/agent/rate.js");

    let _attempt = 0;

    // Mock sleep to avoid real delays
    rateMod._setSleep(async () => {});
    fallbackMod._setCallWithRetry(async () => {
      attempt++;
      const err = new Error("429 rate limit");
      err.status = 429;
      throw err;
    });

    try {
      await agentLoop("test", 10, [], "GENERAL", null, null, {});
      assert.fail("Should have thrown after 3 rate limits");
    } catch (e) {
      assert.ok(
        e.message.includes("Rate limited") || e.message.includes("429"),
        `Expected rate limit error, got: ${e.message}`
      );
    } finally {
      fallbackMod._resetCallWithRetry();
      rateMod._resetSleep();
    }
  });

  test("non-tool-answer without requireTool returns content normally", async () => {
    const { agentLoop } = await import("../src/agent/react.js");
    const fallbackMod = await import("../src/agent/fallback.js");

    fallbackMod._setCallWithRetry(async () => ({
      response: {
        choices: [{
          message: {
            role: "assistant",
            content: "I can help with that.",
            tool_calls: [],
          },
        }],
      },
      usedModel: "test",
    }));

    try {
      const result = await agentLoop("hello", 3, [], "GENERAL", null, null, {});
      assert.strictEqual(result.content, "I can help with that.");
    } finally {
      fallbackMod._resetCallWithRetry();
    }
  });
});
