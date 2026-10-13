import "./setup-env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { _injectDB, migrate, closeDB } from "../src/core/db.js";

test("started enrichment rejections cannot escape discovery during certificate failures", async () => {
  const reject = async () => { throw Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }); };
  mock.module(new URL("../src/integrations/okx.js", import.meta.url).href, { exports: {
    getAdvancedInfo: reject, getPriceInfo: reject, getClusterList: reject, getRiskFlags: reject,
  } });
  const db = new Database(":memory:"); migrate(db); _injectDB(db);
  try {
    const { getTopCandidates, _injectDiscovery, _injectMyPositions } = await import("../src/screening/discovery.js");
    const { config } = await import("../src/config.js");
    const original = { ...config.screening };
    Object.assign(config.screening, { minTvl: 10000, maxTvl: 500000, blockedLaunchpads: [] });
    _injectDiscovery({ pools: [{ pool: "A", active_tvl: 50000, base: { mint: "TokenA" } }] });
    _injectMyPositions(async () => ({ positions: [] }));
    try {
      const result = await getTopCandidates();
      assert.equal(result.candidates.length, 1);
      await new Promise(r => setImmediate(r));
      // node:test fails automatically on an escaped unhandled rejection.
      assert.equal(result.candidates[0].bundle_pct, undefined, "failed enrichment stays unknown");
    } finally { Object.assign(config.screening, original); _injectDiscovery(null); _injectMyPositions(null); }
  } finally { mock.restoreAll(); closeDB(); }
});
