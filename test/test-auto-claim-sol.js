/**
 * Tests for the auto-claim SOL rent removal (local-work-scan review fix).
 *
 * Root cause: claimAndSweepSol built a SystemProgram.transfer FROM the DLMM
 * position PDA. A PDA cannot sign — the tx always failed with missing
 * signature. Position rent is already reclaimed on-chain by the SDK's
 * shouldClaimAndClose/closePosition instructions during close.
 *
 * Contract after fix:
 *  - close-accounts.js no longer exports claimAndSweepSol
 *  - meteora/close.js no longer references it
 *  - claim_position_rent tool is gone from registrations
 *  - auto_claim_sol_enabled flag still exists and defaults false
 *
 * Run: node --test test/test-auto-claim-sol.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import Database from "better-sqlite3";
import { _injectDB } from "../src/core/db.js";
import { isFlagEnabled } from "../src/core/feature-flags.js";

test("auto_claim_sol_enabled flag still defaults to false", () => {
  _injectDB(new Database(":memory:"));
  assert.strictEqual(isFlagEnabled("auto_claim_sol_enabled"), false);
});

test("close-accounts.js no longer exports claimAndSweepSol", async () => {
  const mod = await import("../src/integrations/solana/close-accounts.js");
  assert.strictEqual(mod.claimAndSweepSol, undefined,
    "claimAndSweepSol must be removed — position PDA cannot sign a transfer");
});

test("meteora/close.js no longer references claimAndSweepSol", () => {
  const src = readFileSync(new URL("../src/integrations/meteora/close.js", import.meta.url), "utf8");
  assert.ok(!src.includes("claimAndSweepSol"),
    "close.js must not invoke the removed sweep");
  assert.ok(!src.includes("claimed_sol_rent"),
    "close.js must not surface claimed_sol_rent anymore");
});

test("claim_position_rent tool is fully deregistered", () => {
  const positionsSrc = readFileSync(new URL("../src/tools/positions.js", import.meta.url), "utf8");
  const defsSrc = readFileSync(new URL("../src/tools/position-tools.js", import.meta.url), "utf8");
  const agentSrc = readFileSync(new URL("../src/agent/tools.js", import.meta.url), "utf8");
  assert.ok(!positionsSrc.includes("claim_position_rent"), "positions.js still registers claim_position_rent");
  assert.ok(!defsSrc.includes("claim_position_rent"), "position-tools.js still defines claim_position_rent");
  assert.ok(!agentSrc.includes("claim_position_rent"), "agent/tools.js still lists claim_position_rent");
});
