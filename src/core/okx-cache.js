/**
 * OKX enrichment cache — stores { advanced, price, clusters, risk } per mint.
 * Uses CacheManager for TTL-based eviction. Designed for pre-cycle warmup
 * to eliminate OKX bottleneck on repeated candidates across cycles.
 */

import { CacheManager } from "./cache-manager.js";
import { config } from "../config.js";
import { log } from "./logger.js";
import { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } from "../integrations/okx.js";

const OKX_PER_ENDPOINT_TIMEOUT_MS = 8_000; // must match discovery.js

/** Per-mint OKX cache instance */
export const okxCache = new CacheManager();

/**
 * Get cached OKX data for a mint, or undefined if absent/expired.
 * @param {string} mint
 * @returns {{ advanced: object, price: object, clusters: object[], risk: object } | undefined}
 */
export function getOkxCached(mint) {
  if (!mint) return undefined;
  return okxCache.get(mint);
}

/**
 * Fetch OKX data for a single mint and populate the cache.
 * Silently swallows errors — callers must handle missing data.
 * @param {string} mint
 * @param {number} ttlMs - TTL in milliseconds
 */
export async function fetchAndCacheOkx(mint, ttlMs) {
  if (!mint) return;
  try {
    const [adv, price, clusters, risk] = await Promise.allSettled([
      withTimeout(getAdvancedInfo(mint), OKX_PER_ENDPOINT_TIMEOUT_MS),
      withTimeout(getPriceInfo(mint), OKX_PER_ENDPOINT_TIMEOUT_MS),
      withTimeout(getClusterList(mint), OKX_PER_ENDPOINT_TIMEOUT_MS),
      withTimeout(getRiskFlags(mint), OKX_PER_ENDPOINT_TIMEOUT_MS),
    ]);

    const advanced = adv?.status === "fulfilled" ? adv.value : null;
    const priceData = price?.status === "fulfilled" ? price.value : null;
    const clustersData = clusters?.status === "fulfilled" ? clusters.value : null;
    const riskData = risk?.status === "fulfilled" ? risk.value : null;

    okxCache.set(mint, { advanced, price: priceData, clusters: clustersData, risk: riskData }, ttlMs);
  } catch (err) {
    // Non-fatal — cache miss is acceptable
    log("warn", "okx_cache", `Failed to cache OKX data for ${mint}: ${err?.message}`);
  }
}

/**
 * Apply cached OKX data to a pool object (mutates the pool in-place).
 * Returns true if cache hit, false if not found.
 * @param {object} pool - candidate pool (with base.mint)
 * @returns {boolean}
 */
export function applyOkxCacheToPool(pool) {
  const mint = pool.base?.mint;
  if (!mint) return false;
  const cached = getOkxCached(mint);
  if (!cached) return false;

  const { advanced, price, clusters, risk } = cached;

  if (advanced) {
    pool.risk_level       = advanced.risk_level;
    pool.bundle_pct       = advanced.bundle_pct;
    pool.sniper_pct       = advanced.sniper_pct;
    pool.suspicious_pct   = advanced.suspicious_pct;
    pool.smart_money_buy  = advanced.smart_money_buy;
    pool.dev_sold_all     = advanced.dev_sold_all;
    pool.dex_boost        = advanced.dex_boost;
    pool.dex_screener_paid = advanced.dex_screener_paid;
    if (advanced.creator && !pool.dev) pool.dev = advanced.creator;
  }
  if (risk) {
    pool.is_rugpull = risk.is_rugpull;
    pool.is_wash    = risk.is_wash;
  }
  if (price) {
    pool.price_vs_ath_pct = price.price_vs_ath_pct;
    pool.ath              = price.ath;
  }
  if (clusters?.length) {
    pool.kol_in_clusters      = clusters.some((c) => c.has_kol);
    pool.top_cluster_trend    = clusters[0]?.trend ?? null;
    pool.top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
  }
  return true;
}

/**
 * Pre-fetch OKX data for the top N candidate mints during the idle gap
 * between cycles. Uses the configured warmupConcurrency to limit parallelism.
 *
 * @param {object[]} candidates - pool candidates (each must have base.mint)
 * @param {number} [topN=20] - max mints to warm up
 */
export async function warmupOkxCache(candidates, topN = 20) {
  const ttlMs = config.screening.okxCacheTtlMs ?? 240_000; // default 4 min
  const mints = candidates
    .filter((p) => p.base?.mint)
    .map((p) => p.base.mint)
    .filter((m, i, arr) => arr.indexOf(m) === i) // dedup
    .slice(0, topN);

  if (mints.length === 0) return;

  log("info", "okx_cache", `Warming up OKX cache for ${mints.length} mints...`);
  const start = Date.now();

  await Promise.allSettled(
    mints.map((mint) => fetchAndCacheOkx(mint, ttlMs))
  );

  log("info", "okx_cache", `OKX cache warmup done in ${Date.now() - start}ms`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap a promise with a AbortController timeout */
async function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise.then((v) => {
      clearTimeout(timer);
      return v;
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
