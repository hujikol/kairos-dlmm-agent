// Direct debug of getWalletBalances
process.env.DRY_RUN = "true";
process.env.WALLET_PRIVATE_KEY = "[]";
process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
process.env.OPENROUTER_API_KEY = "test";

import { _injectBalances, getWalletBalances } from "./src/integrations/helius.js";
import { balanceCache } from "./src/core/cache-manager.js";

console.log("balanceCache singleton test:");
console.log("  balanceCache === balanceCache?", balanceCache === balanceCache);

// Check balanceCache internal store
console.log("\nBefore inject:");
console.log("  balanceCache store:", [...balanceCache["#store"]?.entries() ?? []]);

// Inject
_injectBalances({ sol: 5, sol_price: 150, tokens: [] });

console.log("\nAfter inject:");
console.log("  balanceCache store:", [...balanceCache["#store"]?.entries() ?? []]);
console.log("  balanceCache.get('balances'):", balanceCache.get("balances"));

// Call getWalletBalances
console.log("\nCalling getWalletBalances():");
const result = await getWalletBalances();
console.log("  result:", result);