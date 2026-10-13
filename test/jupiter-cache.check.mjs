import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("Jupiter enrichment evicts old distinct tokens and preserves suspicious audit presence", async () => {
  let lookups = 0;
  mock.module(new URL("../src/integrations/okx.js", import.meta.url).href, { exports: {
    getAdvancedInfo: async () => { lookups++; return { bundle_pct: 5 }; }, getClusterList: async () => [],
  } });
  mock.method(globalThis, "fetch", async url => ({ ok: true, json: async () => [{
    id: new URL(url).searchParams.get("query"), audit: { isSus: false, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  }] }));
  try {
    const { getTokenInfo } = await import("../src/integrations/jupiter.js");
    for (let i = 0; i < 101; i++) await getTokenInfo({ query: `token-${i}` });
    assert.equal(lookups, 101);
    const result = await getTokenInfo({ query: "token-0" });
    assert.equal(lookups, 102, "oldest entry must be evicted at 100 distinct tokens");
    assert.equal(result.results[0].audit.suspicious, true, "presence of suspicious field is preserved even when false");
    await getTokenInfo({ query: "token-0" });
    assert.equal(lookups, 102, "recent entries are still cached");
  } finally { mock.restoreAll(); }
});
