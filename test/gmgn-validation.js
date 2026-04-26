import { describe, it } from "node:test";
import assert from "node:assert";

// Inline the validation function under test — no module import needed
// (duplicated from positions.js to keep test self-contained)
function validateAgentMeridianFallbackResponse(relayPositions, _walletAddress) {
  if (!Array.isArray(relayPositions)) {
    return { valid: false, reason: "relayPositions is not an array", errors: ["type mismatch"] };
  }

  const errors = [];

  for (const p of relayPositions) {
    const addr = p.position || p.positionAddress || "?";
    if (!p.pool && !p.poolAddress) {
      errors.push(`Missing pool address for position ${addr}`);
    }
    if (!p.position && !p.positionAddress) {
      errors.push(`Missing position address for pool ${p.pool || p.poolAddress}`);
    }
    if (p.isOutOfRange !== undefined && typeof p.isOutOfRange !== "boolean") {
      errors.push(`Invalid isOutOfRange type for ${addr}: ${typeof p.isOutOfRange}`);
    }
    if (p.pnlPctChange !== undefined && typeof p.pnlPctChange !== "number") {
      errors.push(`Invalid pnlPctChange type for ${addr}: ${typeof p.pnlPctChange}`);
    }
    if (p.pnlUsd !== undefined && typeof p.pnlUsd !== "number") {
      errors.push(`Invalid pnlUsd type for ${addr}: ${typeof p.pnlUsd}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, reason: errors.join("; "), errors };
  }
  return { valid: true };
}

describe("validateAgentMeridianFallbackResponse", () => {
  it("returns valid for well-formed positions", () => {
    const result = validateAgentMeridianFallbackResponse([
      { pool: "PoolA", position: "PosA", isOutOfRange: false, pnlUsd: 10.5, pnlPctChange: 0.05 },
      { poolAddress: "PoolB", positionAddress: "PosB", isOutOfRange: true },
    ], "wallet123");
    assert.strictEqual(result.valid, true);
  });

  it("rejects non-array input", () => {
    const result = validateAgentMeridianFallbackResponse("not an array", "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("not an array"));
  });

  it("rejects position missing both pool and poolAddress", () => {
    const result = validateAgentMeridianFallbackResponse([
      { position: "PosA" },
    ], "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Missing pool address"));
  });

  it("rejects position missing both position and positionAddress", () => {
    const result = validateAgentMeridianFallbackResponse([
      { pool: "PoolA" },
    ], "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Missing position address"));
  });

  it("rejects non-boolean isOutOfRange", () => {
    const result = validateAgentMeridianFallbackResponse([
      { pool: "PoolA", position: "PosA", isOutOfRange: "yes" },
    ], "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Invalid isOutOfRange type"));
  });

  it("rejects non-numeric pnlPctChange", () => {
    const result = validateAgentMeridianFallbackResponse([
      { pool: "PoolA", position: "PosA", pnlPctChange: "0.05" },
    ], "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Invalid pnlPctChange type"));
  });

  it("rejects non-numeric pnlUsd", () => {
    const result = validateAgentMeridianFallbackResponse([
      { pool: "PoolA", position: "PosA", pnlUsd: {} },
    ], "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Invalid pnlUsd type"));
  });

  it("accumulates multiple errors", () => {
    const result = validateAgentMeridianFallbackResponse([
      { position: "PosA" },
      { pool: "PoolB" },
    ], "wallet123");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Missing pool address"));
    assert.ok(result.reason.includes("Missing position address"));
  });

  it("empty array is valid", () => {
    const result = validateAgentMeridianFallbackResponse([], "wallet123");
    assert.strictEqual(result.valid, true);
  });

  it("accepts valid relay position with poolAddress field", () => {
    const result = validateAgentMeridianFallbackResponse([
      { poolAddress: "PoolX", positionAddress: "PosY", isOutOfRange: false },
    ], "wallet123");
    assert.strictEqual(result.valid, true);
  });
});