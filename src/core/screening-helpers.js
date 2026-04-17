/**
 * Screening-cycle helpers: candidate reconstitution, hard filters,
 * candidate block builder.
 */

import { log } from "./logger.js";
import { checkSmartWalletsOnPool } from "../features/smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "../integrations/jupiter.js";
import { recallForPool, isTokenToxic } from "../features/pool-memory.js";
import { detectMarketPhase } from "./phases.js";
import { computeTokenScore } from "./token-score.js";
import { checkTokenCorrelation } from "./correlation.js";
import { fetchPoolIndicators } from "./pool-indicators.js";

// ─── Candidate reconstitution ────────────────────────────────────────────────

/**
 * Reconstitute candidates with smart-wallet data, narrative, token info,
 * pool memory, market phase, and token score.
 */
export async function fetchAndReconCandidates(candidates) {
  return Promise.all(candidates.map(async (pool, idx) => {
    await new Promise(r => setTimeout(r, idx * 100)); // stagger to avoid 429s
    const mint = pool.base?.mint;
    const [smartWallets, narrative, tokenInfo, indicators] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: pool.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      fetchPoolIndicators({ pool_address: pool.pool, poolData: pool, mint }),
    ]);
    return {
      pool,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
      indicators: indicators.status === "fulfilled" ? indicators.value : "",
      mem: recallForPool(pool.pool),
      phase: detectMarketPhase(pool),
      score: computeTokenScore(pool, tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null),
    };
  }));
}

// ─── Hard filters ─────────────────────────────────────────────────────────────

/**
 * Apply hard filters: launchpad blocklist, bot-holder %, toxic tokens,
 * and cross-portfolio token correlation.
 */
export function applyHardFilters(allCandidates, config, prePositions) {
  return allCandidates.filter(({ pool, ti }) => {
    const launchpad = ti?.launchpad ?? null;
    if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
      log("info", "screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
      return false;
    }
    const botPct = ti?.audit?.bot_holders_pct;
    const maxBotHoldersPct = config.screening.maxBotHoldersPct;
    if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
      log("info", "screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
      return false;
    }
    const baseMint = pool.base?.mint;
    if (baseMint && isTokenToxic(baseMint)) {
      log("info", "screening", `Toxic token filter: dropped ${pool.name} — base token has >66% loss rate across 3+ deploys`);
      return false;
    }
    if (baseMint) {
      const corr = checkTokenCorrelation(prePositions.positions || [], baseMint);
      if (corr.exceeds) {
        log("info", "screening", `Correlation filter: dropped ${pool.name} — already ${corr.count} position(s) on token`);
        return false;
      }
    }
    return true;
  });
}

// ─── Candidate block builder ──────────────────────────────────────────────────

/**
 * Build compact text blocks for each candidate, for injection into the LLM prompt.
 */
export function buildCandidateBlocks(passing, activeBinResults, simulations) {
  return passing.map(({ pool, sw, n, ti, mem, phase, score, indicators }, i) => {
    const botPct = ti?.audit?.bot_holders_pct ?? "?";
    const top10Pct = ti?.audit?.top_holders_pct ?? "?";
    const feesSol = ti?.global_fees_sol ?? "?";
    const launchpad = ti?.launchpad ?? null;
    const priceChange = ti?.stats_1h?.price_change;
    const netBuyers = ti?.stats_1h?.net_buyers;
    const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
    const sim = simulations[i];

    const okxParts = [
      pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
      pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
      pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
      pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
      pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
      pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
      pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
    ].filter(Boolean).join(", ");

    const okxTags = [
      pool.smart_money_buy    ? "smart_money_buy"    : null,
      pool.kol_in_clusters    ? "kol_in_clusters"    : null,
      pool.dex_boost          ? "dex_boost"          : null,
      pool.dex_screener_paid  ? "dex_screener_paid"  : null,
      pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
    ].filter(Boolean).join(", ");

    const block = [
      `POOL: ${pool.name} (${pool.pool})`,
      `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
      `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
      okxParts ? `  okx: ${okxParts}` : null,
      okxTags  ? `  tags: ${okxTags}` : null,
      pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
      `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
      `  market_phase: ${phase} | token_score: ${score.score}/${score.max} (${score.label})`,
      activeBin != null ? `  active_bin: ${activeBin}` : null,
      `  sim: daily_fees=$${sim.daily_fees_usd} | est_IL=$${sim.expected_il_usd} | net_daily=$${sim.net_daily_usd} | risk=${sim.risk_score}/100 | confidence=${sim.confidence}/100 | passes=${sim.passes ? "YES" : "NO"}`,
      priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
      n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
      mem ? `  memory: ${mem}` : null,
      indicators ? `${indicators}` : null,
    ].filter(Boolean).join("\n");

    return block;
  });
}
