/**
 * Screening-cycle helpers: candidate reconstitution, hard filters,
 * candidate block builder.
 */

import { log } from "./logger.js";
import { getTokenInfo } from "../integrations/jupiter.js";
import { isTokenToxic } from "../features/pool-memory.js";
import { checkTokenCorrelation } from "./correlation.js";

/**
 * Format a Gmgn candidate as a concise LLM prompt string.
 * Returns a single-line-ish format with key metrics: symbol, mint, mcap,
 * volume, fee, holders, KOL flags, pool info, and chart bounce signal.
 */
export function formatGmgnCandidateForPrompt(candidate) {
  const { pool, ti, bounceResult } = candidate;
  const mint = pool.base?.mint ?? "";
  const symbol = pool.name ?? mint.slice(0, 8);
  const mcap = pool.mcap != null ? `$${pool.mcap}` : "?";
  const volume = pool.volume_window != null ? `$${pool.volume_window}` : "?";
  const fee = pool.fee_pct != null ? `${pool.fee_pct}%` : "?";
  const holders = ti?.audit?.top_holders_pct ?? "?";

  const kolFlags = [
    pool.smart_money_buy ? "sm_buy" : null,
    pool.kol_in_clusters ? "kol_clust" : null,
    pool.dex_screener_paid ? "dex_paid" : null,
    pool.dev_sold_all ? "dev_sold" : null,
  ].filter(Boolean);

  const poolInfo = [
    `tvl=$${pool.active_tvl ?? "?"}`,
    `bs=${pool.bin_step}`,
    `vol2=${pool.volatility ?? "?"}`,
    `org=${pool.organic_score ?? "?"}`,
    pool.token_age_hours != null ? `age=${pool.token_age_hours}h` : null,
  ].filter(Boolean).join(" ");

  let bounceLine = "";
  if (bounceResult && Object.keys(bounceResult).length > 0) {
    const b = bounceResult;
    bounceLine = ` | bounce=${b.pass ? "PASS" : "FAIL"}`;
    if (b.signal?.rsi != null) bounceLine += ` rsi=${b.signal.rsi.toFixed(1)}`;
    if (b.signal?.supertrendDirection) bounceLine += ` st=${b.signal.supertrendDirection}`;
    if (b.reasons?.length) bounceLine += ` [${b.reasons.join(";")}]`;
  }

  return [
    `${symbol} | mint=${mint.slice(0, 6)}.. | mcap=${mcap} vol=${volume} fee=${fee} holders=${holders}%`,
    `  pool: ${poolInfo}`,
    kolFlags.length ? `  kol: ${kolFlags.join(", ")}` : null,
    bounceLine ? `  chart:${bounceLine}` : null,
  ].filter(Boolean).join("\n");
}

// ─── Candidate reconstitution ────────────────────────────────────────────────

/**
 * Fetch only the matched token audit used by deterministic entry rules.
 */
export async function fetchAndReconCandidates(candidates) {
  return Promise.all(candidates.map(async pool => {
    const tokenInfo = pool.base?.mint ? await getTokenInfo({ query: pool.base.mint }).catch(() => null) : null;
    return { pool, ti: tokenInfo?.results?.find(t => t.mint === pool.base?.mint) ?? null };
  }));
}

// ─── Hard filters ─────────────────────────────────────────────────────────────

/**
 * Apply hard filters: launchpad blocklist, bot-holder %, toxic tokens,
 * and cross-portfolio token correlation.
 */
export function applyHardFilters(allCandidates, config, prePositions) {
  return allCandidates.filter(({ pool, ti }) => {
    if (config.screening.requireTokenAudit) {
      const audit = ti?.audit;
      const top = Number(audit?.top_holders_pct), bots = Number(audit?.bot_holders_pct);
      const bundle = pool.bundle_pct ?? ti?.bundle_pct;
      // bundle_pct is supplied only by the OKX enrichment relay. When that relay is
      // unavailable the value is absent, and failing closed on "absent" rejects every
      // candidate in the universe — a single enrichment outage silently disables all
      // trading. Treat unknown as not-failed, but still reject any KNOWN out-of-bounds
      // value. Every other audit check below stays strict.
      const bundleKnown = Number.isFinite(bundle);
      if (!audit || audit.mint_disabled !== true || audit.freeze_disabled !== true || audit.suspicious === true ||
          audit.top_holders_pct == null || audit.bot_holders_pct == null ||
          !Number.isFinite(top) || top < 0 || top > config.screening.maxTop10Pct ||
          !Number.isFinite(bots) || bots < 0 || bots > config.screening.maxBotHoldersPct ||
          (bundleKnown && (bundle < 0 || bundle > config.screening.maxBundlePct)) ||
          !Number.isFinite(ti?.global_fees_sol) || ti.global_fees_sol < config.screening.minTokenFeesSol ||
          pool.risk_level === "high" || ti?.risk_level === "high" ||
          !Number.isFinite(pool.token_age_hours) || pool.token_age_hours < config.screening.minTokenAgeHours ||
          !Number.isFinite(pool.holders) || pool.holders < config.screening.minHolders) return false;
    }
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
    const minSmartDegenCount = config.screening.minSmartDegenCount ?? 1;
    if (minSmartDegenCount > 0 && !pool.smart_money_buy && !pool.kol_in_clusters) {
      log("info", "screening", `SmartMoney filter: dropped ${pool.name} — no smart money signal (smart_money_buy=${pool.smart_money_buy}, kol_in_clusters=${pool.kol_in_clusters})`);
      return false;
    }
    return true;
  });
}

// ─── Candidate block builder ──────────────────────────────────────────────────

/**
 * Build compact candidate blocks for injection into the LLM prompt.
 * Uses a consistent JSON-like field order to reduce token waste and improve LLM parse reliability.
 */
export function buildCandidateBlocks(passing, activeBinResults, simulations) {
  return passing.map(({ pool, sw, n, ti, mem, phase, score, indicators, bounceResult }, i) => {
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

    // Build bounce info for display
    const bounceParts = [];
    if (bounceResult && Object.keys(bounceResult).length > 0) {
      bounceParts.push(`bounce=${bounceResult.pass ? "PASS" : "FAIL"}`);
      if (bounceResult.signal) {
        const { rsi, bbPosition, supertrendDirection, supertrendBreakUp, aboveSupertrend } = bounceResult.signal;
        if (rsi != null) bounceParts.push(`rsi=${rsi.toFixed(1)}`);
        if (bbPosition) bounceParts.push(`bbPos=${bbPosition}`);
        if (supertrendDirection) bounceParts.push(`stDir=${supertrendDirection}`);
        if (supertrendBreakUp != null) bounceParts.push(`stBreak=${supertrendBreakUp}`);
        if (aboveSupertrend != null) bounceParts.push(`aboveSt=${aboveSupertrend}`);
      }
      if (bounceResult.reasons?.length > 0) {
        bounceParts.push(`reasons=${bounceResult.reasons.join("; ")}`);
      }
    }
    const bounceLine = bounceParts.length > 0 ? `  BOUNCE: ${bounceParts.join(" ")}` : null;

    // Compact single-line format — all key metrics on one line, sim result prominent
    const block = [
      `POOL: ${pool.name} (${pool.pool})`,
      `  METRICS: bs=${pool.bin_step} fee=${pool.fee_pct}% ftvl=${pool.fee_active_tvl_ratio} vol=$${pool.volume_window} tvl=$${pool.active_tvl} vol2=${pool.volatility} mcap=$${pool.mcap} org=${pool.organic_score}${pool.token_age_hours != null ? ` age=${pool.token_age_hours}h` : ""}`,
      `  AUDIT: top10=${top10Pct}% bots=${botPct}% fees=${feesSol}SOL${launchpad ? ` lp=${launchpad}` : ""}`,
      okxParts ? `  OKX: ${okxParts}` : null,
      okxTags  ? `  TAGS: ${okxTags}` : null,
      pool.price_vs_ath_pct != null ? `  ATH: vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? ` cluster=${pool.top_cluster_trend}` : ""}` : null,
      `  SW: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → BOOST [${sw.in_pool.map(w => w.name).join(", ")}]` : ""}`,
      `  PHASE: ${phase} | SCORE: ${score.score}/${score.max} (${score.label})`,
      activeBin != null ? `  ABIN: ${activeBin}` : null,
      `  SIM: fees=$${sim.daily_fees_usd} il=$${sim.expected_il_usd} net=$${sim.net_daily_usd} risk=${sim.risk_score} conf=${sim.confidence} pass=${sim.passes ? "YES" : "NO"}`,
      priceChange != null ? `  1H: ${priceChange >= 0 ? "+" : ""}${priceChange}% nb=${netBuyers ?? "?"}` : null,
      n?.narrative ? `  NARR: ${n.narrative.slice(0, 300)}` : null,
      mem ? `  MEM: ${mem}` : null,
      bounceLine,
      indicators ? `${indicators}` : null,
    ].filter(Boolean).join("\n");

    return block;
  });
}
