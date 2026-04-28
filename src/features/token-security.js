/**
 * Token Security — pre-deploy safety gate.
 *
 * Blocks toxic tokens before they reach the screener based on:
 * - Holder concentration (top 3 > 90% = suspicious)
 * - Honeypot / no-sell tokens
 * - Rugged tokens (owner can destroy)
 * - Blacklisted mints (from token-blacklist.js)
 * - Toxic token history (from pool-memory.js isTokenToxic)
 *
 * TTL cache: 5 minutes per token mint.
 */

import { getTokenHolders as _getTokenHolders } from "../integrations/jupiter.js";
import { getTokenSecurity as _gmgnTokenSecurity } from "../integrations/gmgn.js";
import { isBlacklisted } from "./token-blacklist.js";
import { isTokenToxic } from "./pool-memory.js";
import { log } from "../core/logger.js";
import { CacheManager } from "../core/cache-manager.js";

// ─── Cache ────────────────────────────────────────────────────────

const _cache = new CacheManager();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Test injection for mocking ──────────────────────────────────────

let _testHoldersFn = null;

/**
 * Inject a mock getTokenHolders function for testing.
 * @param {Function|null} fn - Mock function or null to reset
 */
export function _injectHolders(fn) {
  _testHoldersFn = fn;
}

/**
 * Invalidate the token security cache.
 * Exported for use in tests and when manual cache clear is needed.
 */
export function clearTokenSecurityCache() {
  _cache.clear();
}

// ─── Main export ───────────────────────────────────────────────────

/**
 * Returns { safe: boolean, reason?: string } for the given token mint.
 * Cached for 5 minutes per mint.
 *
 * @param {string} tokenMint - Token mint address
 * @returns {Promise<{ safe: boolean, reason?: string }>}
 */
export async function isTokenSafe(tokenMint) {
  if (!tokenMint) return { safe: false, reason: "no mint provided" };

  const cached = _cache.get(tokenMint);
  if (cached !== undefined) return cached;

  const result = await _isTokenSafeImpl(tokenMint);
  _cache.set(tokenMint, result, CACHE_TTL_MS);
  return result;
}

async function _isTokenSafeImpl(tokenMint) {
  // 1. Blacklist check — fast path, no API call needed
  if (isBlacklisted(tokenMint)) {
    return { safe: false, reason: "token is blacklisted" };
  }

  // 2. Toxic token history (pool-memory)
  if (isTokenToxic(tokenMint)) {
    return { safe: false, reason: "token has >66% loss rate in deploy history" };
  }

  // 3. GMGN token security — honeypot + rug detection (fast, authoritative)
  let gmgnSecurity = null;
  try {
    gmgnSecurity = await _gmgnTokenSecurity(tokenMint);
  } catch (e) {
    log("warn", "token-security", `GMGN security check failed for ${tokenMint}: ${e.message}`);
  }

  if (gmgnSecurity) {
    if (gmgnSecurity.is_honeypot === true) {
      return { safe: false, reason: "GMGN honeypot detected (cannot sell)" };
    }
    if (gmgnSecurity.rug_probability != null && gmgnSecurity.rug_probability >= 0.7) {
      return { safe: false, reason: `GMGN rug probability ${(gmgnSecurity.rug_probability * 100).toFixed(0)}% exceeds 70% threshold` };
    }
    if (gmgnSecurity.is_mint_authority_revoked === false && gmgnSecurity.initial_mint_supply != null) {
      // Dev retains mint authority on a fixed-supply token — potential covert mint
      log("debug", "token-security", `${tokenMint}: mint authority active, checking supply mechanics`);
    }
  }

  // 4. Holder concentration analysis
  let holders;
  try {
    if (_testHoldersFn) {
      holders = await _testHoldersFn({ mint: tokenMint, limit: 20 });
    } else {
      holders = await _getTokenHolders({ mint: tokenMint, limit: 20 });
    }
  } catch (e) {
    log("warn", "token-security", `Failed to fetch holders for ${tokenMint}: ${e.message}`);
    // Can't determine — fail open (screener will apply other filters)
    return { safe: true };
  }

  if (!holders || !holders.holders || holders.holders.length === 0) {
    // No holder data — fail open
    return { safe: true };
  }

  // Filter out pool addresses from concentration calculation
  const realHolders = holders.holders.filter((h) => !h.is_pool);
  if (realHolders.length === 0) {
    return { safe: true };
  }

  // Top 3 holder concentration
  const top3 = realHolders.slice(0, 3);
  const top3Pct = top3.reduce((s, h) => s + (Number(h.pct) || 0), 0);

  if (top3Pct > 90) {
    return { safe: false, reason: `top 3 holders control ${top3Pct.toFixed(1)}% of supply (>90% threshold)` };
  }

  // 4. Honeypot signal: high bundle_pct from OKX enrichment
  if (holders.bundle_pct != null && holders.bundle_pct > 95) {
    return { safe: false, reason: `bundle_pct ${holders.bundle_pct}% suggests honeypot (>95% bundled)` };
  }

  // 5. Rugged token signal: dev_sold_all from OKX enrichment
  if (holders.dev_sold_all === true) {
    return { safe: false, reason: "developer has sold entire position (rugged)" };
  }

  return { safe: true };
}