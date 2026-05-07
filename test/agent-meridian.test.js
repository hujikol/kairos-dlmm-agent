/**
 * Agent Meridian — unit tests for retry/backoff helpers.
 * Run: node --test test/agent-meridian.test.js
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";
import {
  isRetryableStatus,
  retryDelayMs,
  agentMeridianJson,
  fetchWithTimeout,
} from "../src/tools/agent-meridian.js";

// ─── isRetryableStatus ────────────────────────────────────────────────────────

describe("isRetryableStatus", () => {
  it("returns true for 408 Request Timeout", () => {
    assert.equal(isRetryableStatus(408), true);
  });

  it("returns true for 409 Conflict", () => {
    assert.equal(isRetryableStatus(409), true);
  });

  it("returns true for 425 Too Early", () => {
    assert.equal(isRetryableStatus(425), true);
  });

  it("returns true for 429 Too Many Requests", () => {
    assert.equal(isRetryableStatus(429), true);
  });

  it("returns true for 5xx errors", () => {
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(502), true);
    assert.equal(isRetryableStatus(503), true);
  });

  it("returns false for 4xx non-retryable", () => {
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(403), false);
    assert.equal(isRetryableStatus(404), false);
  });

  it("returns false for 2xx", () => {
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(201), false);
  });
});

// ─── retryDelayMs ─────────────────────────────────────────────────────────────

describe("retryDelayMs", () => {
  it("respects Retry-After header when present (seconds)", () => {
    // retryDelayMs reads headers.get("Retry-After")
    const error = {
      headers: {
        get: (k) => k === "Retry-After" ? "7" : null,
      },
    };
    const delay = retryDelayMs(error, 1);
    assert.equal(delay, 7000);
  });

  it("caps Retry-After at 10 seconds", () => {
    const error = {
      headers: {
        get: (k) => k === "Retry-After" ? "60" : null,
      },
    };
    const delay = retryDelayMs(error, 1);
    assert.equal(delay, 10_000);
  });

  it("uses exponential backoff when no Retry-After header", () => {
    const error = new Error("server error");
    const delay1 = retryDelayMs(error, 0);
    const delay2 = retryDelayMs(error, 1);
    const delay3 = retryDelayMs(error, 2);
    assert.equal(delay1, 500);           // min(500*2^0, 5000)
    assert.equal(delay2, 1000);          // min(500*2^1, 5000)
    assert.equal(delay3, 2000);          // min(500*2^2, 5000)
  });

  it("caps exponential delay at 5 seconds", () => {
    const error = new Error("server error");
    const delay = retryDelayMs(error, 10);
    assert.equal(delay, 5000);
  });
});

// ─── fetchWithTimeout ─────────────────────────────────────────────────────────

describe("fetchWithTimeout", () => {
  it("fetchWithTimeout is a function", () => {
    assert.equal(typeof fetchWithTimeout, "function");
  });

  it("resolves when fetch completes within timeout", async () => {
    // Use a fast public endpoint that returns JSON
    const result = await fetchWithTimeout(
      "https://api.agentmeridian.xyz/api/ping",
      {},
      5_000
    );
    // pong or error — just verify it returned something (didn't timeout)
    assert.ok(result !== undefined);
  });

  it("rejects when URL is unreachable within timeout", async () => {
    await assert.rejects(
      () => fetchWithTimeout("http://127.0.0.1:9", {}, 1_000),
      /abort|ECONNREFUSED|timeout|fetch failed|TypeError/i
    );
  });
});

// ─── agentMeridianJson (no retry — existing behavior) ────────────────────────

describe("agentMeridianJson (no retry)", () => {
  it("agentMeridianJson is a function", () => {
    assert.equal(typeof agentMeridianJson, "function");
  });

  it("returns payload on success or handles network error gracefully", async () => {
    // Agent Meridian relay may or may not have /ping — accept any response shape or network error
    try {
      const result = await agentMeridianJson("/ping", {});
      // If it succeeds, result should be an object
      assert.equal(typeof result, "object");
    } catch (e) {
      // If relay is unreachable that's also acceptable
      assert.ok(
        e.message.includes("127.0.0.1") ||
        e.message.includes("ECONNREFUSED") ||
        e.message.includes("timeout") ||
        e.message.includes("fetch") ||
        e.message.includes("network") ||
        e.message.includes("Not found") ||
        e.message.includes("404"),
        `Unexpected error type: ${e.message}`
      );
    }
  });
});

// ─── agentMeridianJson (with retry config) ────────────────────────────────────

describe("agentMeridianJson (retry mode)", () => {
  it("retries on 429 with exponential backoff", async () => {
    let callCount = 0;
    const mockFetch = async (url, opts) => {
      callCount++;
      // First 2 calls return 429, third succeeds
      if (callCount < 3) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({ error: "rate limited" }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ success: true, attempts: callCount }),
      };
    };

    // Temporarily replace global fetch to test retry logic
    const originalFetch = globalThis.fetch;
    let optsPassed = null;
    globalThis.fetch = mockFetch;
    try {
      const result = await agentMeridianJson("/test-retry", {
        retry: { maxAttempts: 5, maxElapsedMs: 15_000, perAttemptTimeoutMs: 5_000 },
        headers: {},
        signal: null,
      });
      assert.equal(callCount, 3, "Should have retried twice then succeeded");
      assert.equal(result.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws immediately on non-retryable 4xx", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ error: "not found" }),
      };
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      await assert.rejects(
        () =>
          agentMeridianJson("/not-found", {
            retry: { maxAttempts: 3, maxElapsedMs: 10_000, perAttemptTimeoutMs: 3_000 },
            headers: {},
            signal: null,
          }),
        /404|Not Found/i
      );
      assert.equal(callCount, 1, "Should NOT retry on 404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
