import "./setup-env.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { _injectDB, closeDB, migrate } from "../src/core/db.js";
import { applyHardFilters } from "../src/core/screening-helpers.js";

after(closeDB);
test("high-volume preset requires audited tokens and bounded distinct-token exposure", () => {
  const db = new Database(":memory:"); migrate(db); _injectDB(db);
  const profile = JSON.parse(fs.readFileSync(new URL("../profiles/high-volume-paper.json", import.meta.url)));
  const cfg = { screening: { blockedLaunchpads: [], ...profile.thresholds } };
  const candidate = { pool: { pool: "A", base: { mint: "TokenA" }, token_age_hours: 72,
    holders: 2000, bundle_pct: 5, organic_score: 80 },
    ti: { global_fees_sol: 50, audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: "10.00", bot_holders_pct: "5.00" } } };
  const apply = c => applyHardFilters([c], cfg, { positions: [] }).length;
  assert.equal(apply(candidate), 1);
  for (const bad of [ { ...candidate, ti: null },
    { ...candidate, ti: { ...candidate.ti, global_fees_sol: 1 } },
    { ...candidate, ti: { ...candidate.ti, audit: { ...candidate.ti.audit, mint_disabled: false } } },
    { ...candidate, ti: { ...candidate.ti, audit: { ...candidate.ti.audit, suspicious: true } } },
    { ...candidate, ti: { ...candidate.ti, audit: { ...candidate.ti.audit, top_holders_pct: null } } },
    { ...candidate, pool: { ...candidate.pool, bundle_pct: 99 } },
    { ...candidate, pool: { ...candidate.pool, holders: 10 } },
    { ...candidate, pool: { ...candidate.pool, token_age_hours: 1 } } ]) assert.equal(apply(bad), 0);
  // bundle_pct is only available from OKX enrichment; an absent value must not reject
  // every candidate when that relay is down. A KNOWN bad value still rejects (above).
  assert.equal(apply({ ...candidate, pool: { ...candidate.pool, bundle_pct: null } }), 1, "unknown bundle is tolerated");
  assert.equal(applyHardFilters([candidate], cfg, { positions: [{ base_mint: "TokenA" }] }).length, 0);
  assert.equal(profile.risk.maxPositions, 3);
  assert.equal(profile.management.maxDeployAmount, 3);
  assert.equal(profile.dryRun, true);
});
