// Test: does runSafetyChecks see the injected balance?
process.env.DRY_RUN = "true";
process.env.WALLET_PRIVATE_KEY = "[]";
process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
process.env.OPENROUTER_API_KEY = "test";

import { makeSchemaDB } from "./test/mem-db.js";
import { _injectDB, closeDB } from "./src/core/db.js";
import { _injectPositionsCache, _resetPositionsCache } from "./src/integrations/meteora/positions.js";
import { _injectBalances } from "./src/integrations/helius.js";
import { balanceCache } from "./src/core/cache-manager.js";
import { executeTool } from "./src/tools/executor.js";
import { clearCache } from "./src/tools/cache.js";

const db = await makeSchemaDB();
_injectDB(db);
_resetPositionsCache();
_injectPositionsCache(null);
_injectBalances(null);
clearCache();

_injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
_injectBalances({ sol: 5, sol_price: 150, tokens: [] });

console.log("balanceCache.get('balances') at test time:", balanceCache.get("balances"));

// Now call the executor
const r = await executeTool("deploy_position", { pool_address: "DryRunPool", bin_step: 100 });
console.log("Result:", JSON.stringify(r, null, 2));

await closeDB();