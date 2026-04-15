// meteora.js — backward-compatibility re-export wrapper
// All functionality has been moved to src/integrations/meteora/

export {
  DLMM_PROGRAM,
  getConnection,
  getWallet,
  getDLMM,
  applyPriorityFee,
  sendTx,
  getPool,
  getActiveBin,
  searchPools,
  lookupPoolForPosition,
} from "./meteora/index.js";

export {
  POSITIONS_CACHE_TTL,
  invalidatePositionsCache,
  deployPosition,
  getMyPositions,
  getWalletPositions,
} from "./meteora/index.js";

export {
  fetchDlmmPnlForPool,
  getPositionPnl,
} from "./meteora/index.js";

export {
  claimFees,
  closePosition,
} from "./meteora/index.js";
