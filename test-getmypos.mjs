import { _injectPositionsCache, _resetPositionsCache, getMyPositions } from "./src/integrations/meteora/positions.js";
import { _injectBalances } from "./src/integrations/helius.js";
import { balanceCache, positionsCache } from "./src/core/cache-manager.js";

process.env.DRY_RUN = "true";
process.env.WALLET_PRIVATE_KEY = "[]";
process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
process.env.OPENROUTER_API_KEY = "test";

_resetPositionsCache();
_injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });
_injectBalances({ sol: 5, sol_price: 150, tokens: [] });

console.log("positionsCache.get('positions'):", positionsCache.get("positions"));
console.log("balanceCache.get('balances'):", balanceCache.get("balances"));

const result = await getMyPositions({ force: true });
console.log("getMyPositions({ force: true }):", JSON.stringify(result).slice(0, 300));