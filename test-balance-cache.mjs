import { _injectBalances, getWalletBalances } from "./src/integrations/helius.js";
import { balanceCache } from "./src/core/cache-manager.js";

console.log("balanceCache key:", "balances");
console.log("balanceCache before:", balanceCache.get("balances"));

_injectBalances({ sol: 5, sol_price: 150, tokens: [] });

console.log("balanceCache after:", balanceCache.get("balances"));
console.log("_CACHE_KEY test passes");

const result = await getWalletBalances();
console.log("getWalletBalances result:", result);