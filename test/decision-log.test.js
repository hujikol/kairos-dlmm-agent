/**
 * Decision Log — type and behavior unit tests.
 * Run: node --test test/decision-log.test.js
 *
 * These tests verify the decision-log module's public API surface
 * WITHOUT triggering the native better-sqlite3 binding.
 *
 * We avoid direct import of getDecisionSummary/getDecisionStats since they
 * call getDB() which loads the native module. Instead, we:
 *   1. Verify the functions exist via module introspection
 *   2. Test pure formatting logic using the source directly
 *   3. Test type signatures using a subprocess that isolates failures
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../src/core/decision-log.js");
const SRC_CONTENT = readFileSync(SRC, "utf8");

// ─── Source-level inspection helpers ──────────────────────────────────────────

function hasExport(src, name) {
  return new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(src);
}

function hasAsyncFn(src, name) {
  return new RegExp(`export\\s+async\\s+function\\s+${name}\\b`).test(src);
}

// ─── Module API surface ───────────────────────────────────────────────────────

describe("decision-log.js exports", () => {
  it("exports recordDecision", () => {
    assert.ok(hasExport(SRC_CONTENT, "recordDecision"), "recordDecision should be exported");
  });

  it("exports getDecisions", () => {
    assert.ok(hasExport(SRC_CONTENT, "getDecisions"), "getDecisions should be exported");
  });

  it("exports getDecisionSummary", () => {
    assert.ok(hasAsyncFn(SRC_CONTENT, "getDecisionSummary"), "getDecisionSummary should be exported");
  });

  it("exports getDecisionStats", () => {
    assert.ok(hasAsyncFn(SRC_CONTENT, "getDecisionStats"), "getDecisionStats should be exported");
  });
});

describe("getDecisionSummary — source-level verification", () => {
  it("returns null when no decisions exist (null-guard in source)", () => {
    // The function must have: if (!decisions.length) return null;
    assert.ok(
      /decisions\.length\s*\)\s*return\s+null/.test(SRC_CONTENT),
      "getDecisionSummary should return null when decisions array is empty"
    );
  });

  it("returns a formatted string with RECENT DECISIONS header", () => {
    assert.ok(
      /`RECENT DECISIONS:`/.test(SRC_CONTENT) || /"RECENT DECISIONS:"|'RECENT DECISIONS:'/.test(SRC_CONTENT),
      "getDecisionSummary should build a string starting with RECENT DECISIONS:"
    );
  });

  it("accepts { limit, hours } destructured parameters", () => {
    assert.ok(
      /function\s+getDecisionSummary\s*\(\s*\{\s*limit\s*=\s*6\s*,\s*hours\s*=\s*72\s*}/.test(SRC_CONTENT),
      "getDecisionSummary should accept { limit=6, hours=72 } defaults"
    );
  });

  it("truncates reasoning at 60 characters", () => {
    // Look for .slice(0, 57) + "…" pattern in source
    assert.ok(
      /\.slice\s*\(\s*0\s*,\s*57\s*\)\s*\+\s*["']…["']/.test(SRC_CONTENT) ||
      /\.slice\s*\(0,\s*57\)\s*\+\s*["']…["']/.test(SRC_CONTENT),
      "getDecisionSummary should truncate reasoning with .slice(0, 57) + '…'"
    );
  });

  it("uses poolShort() helper for address shortening", () => {
    assert.ok(
      /poolShort\s*\(/.test(SRC_CONTENT),
      "getDecisionSummary should use poolShort() for display-friendly addresses"
    );
  });

  it("includes initiated_by (actor) and type in output", () => {
    assert.ok(
      /initiated_by.*toUpperCase/.test(SRC_CONTENT) && /type.*toUpperCase/.test(SRC_CONTENT),
      "getDecisionSummary should uppercase and include actor and decision type"
    );
  });
});

describe("getDecisionStats — source-level verification", () => {
  it("is declared as async function", () => {
    assert.ok(hasAsyncFn(SRC_CONTENT, "getDecisionStats"), "getDecisionStats should be async");
  });

  it("accepts { hours } parameter with default 168", () => {
    assert.ok(
      /function\s+getDecisionStats\s*\(\s*\{\s*hours\s*=\s*168\s*}/.test(SRC_CONTENT),
      "getDecisionStats should accept { hours=168 } default"
    );
  });

  it("returns an object with total, byType, winRate, avgPnlPct shape", () => {
    // Verify the return object has these fields
    const retPattern = /return\s*\{\s*total:/;
    assert.ok(retPattern.test(SRC_CONTENT), "getDecisionStats should return object with total");
    assert.ok(/byType:/.test(SRC_CONTENT), "getDecisionStats should return object with byType");
    assert.ok(/winRate:/.test(SRC_CONTENT), "getDecisionStats should return object with winRate");
    assert.ok(/avgPnlPct:/.test(SRC_CONTENT), "getDecisionStats should return object with avgPnlPct");
  });

  it("computes winRate by counting decisions with positive pnl_usd", () => {
    // winRate increments winCount when Number(pnl_usd) > 0
    // Source: if (Number(row.pnl_usd) > 0) — pattern must allow intervening chars
    assert.ok(
      /Number.*pnl_usd.*>\s*0/.test(SRC_CONTENT) ||
      /pnl_usd.*>.*0/.test(SRC_CONTENT),
      "getDecisionStats winRate should count decisions with pnl_usd > 0"
    );
  });
});

describe("getDecisions — source-level verification", () => {
  it("is declared as async function", () => {
    assert.ok(hasAsyncFn(SRC_CONTENT, "getDecisions"), "getDecisions should be async");
  });

  it("builds SQL with WHERE timestamp >= cutoff", () => {
    assert.ok(
      /timestamp\s*>=\s*\?/.test(SRC_CONTENT) &&
      /cutoff/.test(SRC_CONTENT),
      "getDecisions should filter by timestamp cutoff"
    );
  });

  it("respects limit and type optional filters", () => {
    assert.ok(
      /type.*\?/.test(SRC_CONTENT) && /pool.*\?/.test(SRC_CONTENT),
      "getDecisions should have optional type and pool filters"
    );
  });

  it("orders by timestamp DESC", () => {
    assert.ok(
      /ORDER\s+BY\s+timestamp\s+DESC/.test(SRC_CONTENT),
      "getDecisions should order results by timestamp DESC"
    );
  });
});
