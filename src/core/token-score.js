export function computeTokenScore(pool, tokenInfo) {
  let score = 0;
  const breakdown = {};

  // Has SOL pair (base or quote)
  const hasSol = pool.quote_mint?.includes("So11111") || pool.quote?.mint?.includes("So11111") || pool.base_mint?.includes("So11111") || pool.base?.mint?.includes("So11111");
  score += hasSol ? 1 : 0;
  breakdown.has_sol_pair = hasSol;

  // Has stablecoin pair
  const hasStable = pool.quote_mint?.includes("EPjF") || pool.quote?.mint?.includes("EPjF") || pool.quote_mint?.includes("Es9v") || pool.quote?.mint?.includes("Es9v");
  score += hasStable ? 1 : 0;
  breakdown.has_stable_pair = hasStable;

  // Volume > $500K/24h
  const vol24 = (pool.volume_window ?? pool.fee_24h ?? 0);
  const hasVolume = vol24 > 500000;
  score += hasVolume ? 1 : 0;
  breakdown.volume_500k = hasVolume;

  // TVL > $100K
  const hasTVL = (pool.active_tvl ?? 0) > 100000;
  score += hasTVL ? 1 : 0;
  breakdown.tvl_100k = hasTVL;

  // Holders > 1000
  const holders = tokenInfo?.holders ?? pool.holders ?? 0;
  const hasHolders = holders > 1000;
  score += hasHolders ? 1 : 0;
  breakdown.holders_1k = hasHolders;

  // No bundled supply > 30%
  const bundlePct = pool.bundle_pct ?? tokenInfo?.bundle_pct ?? 0;
  const noBundle = bundlePct <= 30;
  score += noBundle ? 1 : 0;
  breakdown.no_bundle = noBundle;

  // Organic score > 70
  const organic = pool.organic_score ?? tokenInfo?.organic_score ?? 0;
  const goodOrganic = organic > 70;
  score += goodOrganic ? 1 : 0;
  breakdown.organic_70 = goodOrganic;

  // Multiple liquidity routes (from token audit)
  const hasAudit = tokenInfo?.audit && !tokenInfo.audit.no_pools;
  score += hasAudit ? 1 : 0;
  breakdown.has_audit = hasAudit;

  let label;
  if (score < 3) label = "TRASH \u2014 skip";
  else if (score <= 5) label = "OK \u2014 deploy with caution";
  else if (score <= 7) label = "GOOD \u2014 deploy normally";
  else label = "EXCELLENT \u2014 deploy with conviction";

  return { score, max: 8, label, breakdown };
}
