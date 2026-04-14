// Backward-compatible re-exports — all public APIs from the old helius.js
// Sub-modules maintain identical signatures and behavior

export { normalizeMint } from "./normalize.js";
export { swapToken } from "./swaps.js";
export {
  getWalletBalances,
  getBalancesViaRpc,
  getMintBalance,
  CACHE_TTL,
  invalidateBalanceCache,
  getBalanceCacheAgeMs,
  getCachedBalance,
  _injectBalances,
} from "./balances.js";
export {
  autoSwapRewardFees,
  swapAllTokensToSol,
} from "./auto.js";