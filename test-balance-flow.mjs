// Debug: trace what happens in DRY_RUN test flow
import { makeSchemaDB } from "./test/mem-db.js";
import { _injectDB, closeDB } from "./src/core/db.js";
import { _injectPositionsCache, _resetPositionsCache } from "./src/integrations/meteora/positions.js";
import { _injectBalances } from "./src/integrations/helius.js";
import { clearCache } from "./src/tools/cache.js";
import { balanceCache } from "./src/core/cache-manager.js";
import { executeTool } from "./src/tools/executor.js";

process.env.DRY_RUN = "true";

// Simulate beforeEach
const db = await makeSchemaDB();
_injectDB(db);
_resetPositionsCache();
_injectPositionsCache(null);
_injectBalances(null);
clearCache();

console.log("Before inject, balanceCache.get('balances'):", balanceCache.get("balances"));

_injectBalances({ sol: 5, sol_price: 150, tokens: [] });
console.log("After inject, balanceCache.get('balances'):", balanceCache.get("balances"));

_injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

const result = await executeTool("deploy_position", {
  pool_address: "DryRunPool",
  bin_step: 100,
});
console.log("Result:", JSON.stringify(result, null, 2));

await closeDB();
delete process.env.DRY_RUN;