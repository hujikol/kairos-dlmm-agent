/**
 * OKX DEX API helpers — public endpoints (no API key required)
 * Uses Ok-Access-Client-type: agent-cli header for unauthenticated access.
 * Docs: https://web3.okx.com/build/dev-docs/
 */

import { config } from "../config.js";

const BASE = process.env.OKX_API_BASE || "https://web3.okx.com";
const CHAIN_SOLANA = "501";
const PUBLIC_HEADERS = { "Ok-Access-Client-type": "agent-cli" };

/**
 * Wrap a fetch call with an AbortController timeout.
 */
async function withTimeout(fetchPromise, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchPromise(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function okxGet(path) {
  const res = await withTimeout(
    fetch(`${BASE}${path}`, { headers: PUBLIC_HEADERS }),
    config.okx?.okxApiTimeoutMs ?? 12_000,
  );
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg}`);
  return json.data;
}

// ─── Test injection ────────────────────────────────────────────────
let _testOkxOverride = null; // function(mint) → result or null

export function _injectOkx(fn) {
  _testOkxOverride = fn;
}

async function okxPost(path, body) {
  const res = await withTimeout(
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { ...PUBLIC_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    config.okx?.okxApiTimeoutMs ?? 12_000,
  );
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg}`);
  return json.data;
}

const pct = (v) => v != null && v !== "" ? parseFloat(v) : null;
const int = (v) => v != null && v !== "" ? parseInt(v, 10) : null;

function isAffirmative(label) {
  return typeof label === "string" && label.trim().toLowerCase() === "yes";
}

function collectRiskEntries(section) {
  if (!section || typeof section !== "object") return [];
  return [
    ...(Array.isArray(section.highRiskList) ? section.highRiskList : []),
    ...(Array.isArray(section.middleRiskList) ? section.middleRiskList : []),
    ...(Array.isArray(section.lowRiskList) ? section.lowRiskList : []),
  ];
}

/**
 * Token risk flags from OKX's nested risk check endpoint.
 * Rugpull is informational only; wash trading is used as a hard filter upstream.
 */
export async function getRiskFlags(tokenAddress, chainId = CHAIN_SOLANA) {
  if (_testOkxOverride !== null) return _testOkxOverride(tokenAddress);
  const ts = Date.now();
  const path = `/priapi/v1/dx/market/v2/risk/new/check?chainId=${chainId}&tokenContractAddress=${tokenAddress}&t=${ts}`;
  const data = await okxGet(path);

  const entries = [
    ...collectRiskEntries(data?.allAnalysis),
    ...collectRiskEntries(data?.swapAnalysis),
    ...collectRiskEntries(data?.contractAnalysis),
    ...collectRiskEntries(data?.extraAnalysis),
  ];

  const hasRisk = (riskKey) =>
    entries.some((entry) => entry?.riskKey === riskKey && isAffirmative(entry?.newRiskLabel));

  return {
    is_rugpull: hasRisk("isLiquidityRemoval"),
    is_wash: hasRisk("isWash"),
    risk_level: int(data?.riskLevel ?? data?.riskControlLevel),
    source: "okx-risk-check",
  };
}

/**
 * Advanced token info — risk level, bundle/sniper/suspicious %, dev rug history, token tags.
 */
export async function getAdvancedInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
  if (_testOkxOverride !== null) {
    return _testOkxOverride(tokenAddress);
  }
  const path = `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;

  const tags = d.tokenTags || [];
  return {
    risk_level:       int(d.riskControlLevel),
    bundle_pct:       pct(d.bundleHoldingPercent),
    sniper_pct:       pct(d.sniperHoldingPercent),
    suspicious_pct:   pct(d.suspiciousHoldingPercent),
    dev_holding_pct:  pct(d.devHoldingPercent),
    top10_pct:        pct(d.top10HoldPercent),
    lp_burned_pct:    pct(d.lpBurnedPercent),
    total_fee_sol:    pct(d.totalFee),
    dev_rug_count:    int(d.devRugPullTokenCount),
    dev_token_count:  int(d.devCreateTokenCount),
    creator:          d.creatorAddress || null,
    tags,
    is_honeypot:          tags.includes("honeypot"),
    smart_money_buy:      tags.includes("smartMoneyBuy"),
    dev_sold_all:         tags.includes("devHoldingStatusSellAll"),
    dev_buying_more:      tags.includes("devHoldingStatusBuy"),
    low_liquidity:        tags.includes("lowLiquidity"),
    dex_boost:            tags.includes("dexBoost"),
    dex_screener_paid:    tags.includes("dexScreenerPaid") || tags.includes("dsPaid"),
  };
}

/**
 * Top holder clusters — trend direction, holding period, KOL presence, PnL.
 * Condenses to top N clusters for LLM consumption.
 */
export async function getClusterList(tokenAddress, chainIndex = CHAIN_SOLANA, limit = 5) {
  if (_testOkxOverride !== null) return _testOkxOverride(tokenAddress);
  const path = `/api/v6/dex/market/token/cluster/list?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  // Public endpoint returns data.clusterList (not data[0].clustList)
  const raw = data?.clusterList ?? (Array.isArray(data) ? data[0]?.clustList ?? [] : []);
  if (!raw.length) return [];

  return raw.slice(0, limit).map((c) => {
    const hasKol = (c.clusterAddressList || []).some((a) => a.isKol);
    return {
      holding_pct:   pct(c.holdingPercent),
      trend:         c.trendType?.trendType || c.trendType || null,
      avg_hold_days: c.averageHoldingPeriod ? Math.round(parseFloat(c.averageHoldingPeriod) / 86400) : null,
      pnl_pct:       pct(c.pnlPercent),
      buy_vol_usd:   pct(c.buyVolume),
      sell_vol_usd:  pct(c.sellVolume),
      avg_buy_price: pct(c.averageBuyPriceUsd),
      has_kol:       hasKol,
      address_count: (c.clusterAddressList || []).length,
    };
  });
}

/**
 * Price info — current price, ATH (maxPrice), ATL, multi-timeframe volume + price change.
 * Also returns holders, marketCap, liquidity from this endpoint.
 */
export async function getPriceInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
  if (_testOkxOverride !== null) return _testOkxOverride(tokenAddress);
  const data = await okxPost("/api/v6/dex/market/price-info", [
    { chainIndex, tokenContractAddress: tokenAddress },
  ]);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;
  const price    = parseFloat(d.price    || 0);
  const maxPrice = parseFloat(d.maxPrice || 0);
  return {
    price,
    ath:              maxPrice,
    atl:              parseFloat(d.minPrice || 0),
    price_vs_ath_pct: maxPrice > 0 ? parseFloat(((price / maxPrice) * 100).toFixed(1)) : null,
    price_change_5m:  pct(d.priceChange5M),
    price_change_1h:  pct(d.priceChange1H),
    volume_5m:        pct(d.volume5M),
    volume_1h:        pct(d.volume1H),
    holders:          int(d.holders),
    market_cap:       pct(d.marketCap),
    liquidity:        pct(d.liquidity),
  };
}

/**
 * Fetch all three in parallel — use this during screening enrichment.
 */
export async function getFullTokenAnalysis(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const [advanced, clusters, price] = await Promise.allSettled([
    getAdvancedInfo(tokenAddress, chainIndex),
    getClusterList(tokenAddress, chainIndex),
    getPriceInfo(tokenAddress, chainIndex),
  ]);
  return {
    advanced: advanced.status === "fulfilled" ? advanced.value : null,
    clusters: clusters.status === "fulfilled" ? clusters.value : [],
    price:    price.status    === "fulfilled" ? price.value    : null,
  };
}
