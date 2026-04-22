import { out, COMMAND_DEFAULTS } from "../utils.js";
import { CANDIDATES_RATE_LIMIT_DELAY_MS } from "../../core/constants.js";
import { getTopCandidates } from "../../screening/discovery.js";
import { getActiveBin } from "../../integrations/meteora.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "../../integrations/jupiter.js";
import { checkSmartWalletsOnPool } from "../../features/smart-wallets.js";
import { recallForPool } from "../../features/pool-memory.js";

export async function candidatesCmd(argv, flags) {
  const limit = parseInt(flags.limit || String(COMMAND_DEFAULTS.CANDIDATES_LIMIT));
  const raw = await getTopCandidates({ limit });
  const pools = raw.candidates || raw.pools || [];

  const enriched = [];
  for (const pool of pools) {
    const mint = pool.base?.mint;
    const [activeBin, smartWallets, tokenInfo, holders, narrative] = await Promise.allSettled([
      getActiveBin({ pool_address: pool.pool }),
      checkSmartWalletsOnPool({ pool_address: pool.pool }),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      mint ? getTokenHolders({ mint }) : Promise.resolve(null),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
    ]);
    const ti = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
    enriched.push({
      pool: pool.pool,
      name: pool.name,
      bin_step: pool.bin_step,
      fee_pct: pool.fee_pct,
      fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
      volume: pool.volume_window,
      tvl: pool.active_tvl,
      volatility: pool.volatility,
      mcap: pool.mcap,
      organic_score: pool.organic_score,
      active_pct: pool.active_pct,
      price_change_pct: pool.price_change_pct,
      active_bin: activeBin.status === "fulfilled" ? activeBin.value?.binId : null,
      smart_wallets: smartWallets.status === "fulfilled" ? (smartWallets.value?.in_pool || []).map(w => w.name) : [],
      token: {
        mint,
        symbol: pool.base?.symbol,
        holders: pool.holders,
        mcap: ti?.mcap,
        launchpad: ti?.launchpad,
        global_fees_sol: ti?.global_fees_sol,
        price_change_1h: ti?.stats_1h?.price_change,
        net_buyers_1h: ti?.stats_1h?.net_buyers,
        audit: {
          top10_pct: ti?.audit?.top_holders_pct,
          bots_pct: ti?.audit?.bot_holders_pct,
        },
      },
      holders: holders.status === "fulfilled" ? holders.value : null,
      narrative: narrative.status === "fulfilled" ? narrative.value?.narrative : null,
      pool_memory: recallForPool(pool.pool) || null,
    });
    await new Promise(r => setTimeout(r, CANDIDATES_RATE_LIMIT_DELAY_MS)); // avoid 429s
  }

  out({ candidates: enriched, total_screened: raw.total_screened });
}
