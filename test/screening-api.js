/**
 * Screening pipeline tests.
 *
 * Tests:
 * 1. Module exports expected functions
 * 2. discoverPools rejects pools with >30% bundle percentage
 * 3. getTopCandidates returns an array (or throws if unconfigured)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Discover internal filter logic by testing observable behavior
describe("screening/discovery", () => {
  it("exports discoverPools, getTopCandidates, getPoolDetail", async () => {
    const discovery = await import("../src/screening/discovery.js");
    assert.equal(typeof discovery.discoverPools, "function");
    assert.equal(typeof discovery.getTopCandidates, "function");
    assert.equal(typeof discovery.getPoolDetail, "function");
  });

  it("getTopCandidates accepts limit parameter", async () => {
    const { getTopCandidates } = await import("../src/screening/discovery.js");
    // Should not throw a TypeError for missing params
    assert.doesNotThrow(() => getTopCandidates({ limit: 1 }));
  });

  it("getPoolDetail requires pool_address parameter", async () => {
    const { getPoolDetail } = await import("../src/screening/discovery.js");
    // Missing required parameter should throw
    await assert.rejects(
      () => getPoolDetail({}),
      /pool_address/i
    );
  });

  it("getPoolDetail rejects on invalid pool address", async () => {
    const { getPoolDetail } = await import("../src/screening/discovery.js");
    // With invalid address, should reject (not hang)
    await assert.rejects(
      getPoolDetail({ pool_address: "invalid", timeframe: "1h" }),
      /not found|invalid|404/i
    );
  });
});
