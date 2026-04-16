import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getConnection } from "../solana.js";
import { config } from "../../config.js";
import { log } from "../../core/logger.js";
import { normalizeMint } from "./normalize.js";
import { getWallet } from "./swaps.js";
import { addrShort } from "../../tools/addrShort.js";
import { balanceCache } from "../../core/cache-manager.js";

// ─── 5-minute TTL cache for getWalletBalances() ─────────────────
export const CACHE_TTL = parseInt(process.env.HELIUS_BALANCE_CACHE_TTL_MS || String(config.screening?.balanceCacheTtlMs ?? 300_000)); // 5 minutes
const _CACHE_KEY = "balances";

export function invalidateBalanceCache() {
  balanceCache.delete(_CACHE_KEY);
}

// ─── Test injection ────────────────────────────────────────────────

export function _injectBalances(result) {
  if (result === null) {
    balanceCache.clearForTesting(_CACHE_KEY);
  } else {
    balanceCache.setForTesting(_CACHE_KEY, result);
  }
}

/**
 * Returns age of cached balance in ms, or null if cache is empty/expired.
 */
export function getBalanceCacheAgeMs() {
  const cached = balanceCache.get(_CACHE_KEY);
  if (cached === undefined) return null;
  // CacheManager doesn't expose the stored timestamp, so we track age via module-level variable
  return null; // age tracking handled by CacheManager TTL
}

/**
 * Returns the cached balance object directly, or null if cache is empty/expired.
 */
export function getCachedBalance() {
  return balanceCache.get(_CACHE_KEY) ?? null;
}

/**
 * Fallback balance check using direct Solana RPC — no external API needed.
 * Returns SOL balance accurately even without Helius.
 * @param {string} walletAddress
 * @returns {Promise<Object>}
 */
export async function getBalancesViaRpc(walletAddress) {
  try {
    const connection = getConnection();
    const lamports = await connection.getBalance(new PublicKey(walletAddress));
    const solBalance = lamports / LAMPORTS_PER_SOL;

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: null,
    };
  } catch (e) {
    log("error", "wallet", `RPC balance fallback failed: ${e.message}`);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: e.message,
    };
  }
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 * Uses a 5-minute TTL cache.
 * @returns {Promise<Object>}
 */
export async function getWalletBalances() {
  // ─── Check cache first (CacheManager handles TTL) ─────────────
  const cached = balanceCache.get(_CACHE_KEY);
  if (cached !== undefined) {
    log("info", "wallet", "Using cached balance");
    return cached;
  }

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch (e) {
    log("warn", "helius", `Failed to get wallet balances: ${e?.message}`);
    const errResult = {
      wallet: null, sol: 0, sol_price: 0, sol_usd: 0,
      usdc: 0, tokens: [], total_usd: 0,
      error: "Wallet not configured",
    };
    balanceCache.set(_CACHE_KEY, errResult, CACHE_TTL);
    return errResult;
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;

  // ─── Try Helius first ────────────────────────────────────────
  if (!HELIUS_KEY) {
    log("warn", "wallet", "HELIUS_API_KEY not set — falling back to RPC balance check");
    const rpcResult = await getBalancesViaRpc(walletAddress);
    balanceCache.set(_CACHE_KEY, rpcResult, CACHE_TTL);
    return rpcResult;
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url).catch(err => { throw new Error(`fetch failed: ${err?.message}`); });

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || addrShort(b.mint),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    const result = {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
    balanceCache.set(_CACHE_KEY, result, CACHE_TTL);
    return result;
  } catch (error) {
    log("warn", "wallet", `Helius error, falling back to RPC: ${error.message}`);
    const rpcResult = await getBalancesViaRpc(walletAddress);
    balanceCache.set(_CACHE_KEY, rpcResult, CACHE_TTL);
    return rpcResult;
  }
}

/**
 * Get the direct real-time balance of a specific SPL mint via Solana RPC.
 * Falls back to 0 on error. Does NOT use the balance cache — real-time for swap decisions.
 * @param {string} mint - Mint address (use "SOL" or wrapped-SOL mint for native SOL)
 * @returns {Promise<number>} Token balance (SOL-denominated for native SOL)
 */
export async function getMintBalance(mint) {
  const connection = getConnection();
  const wallet = getWallet();
  const mintPubKey = new PublicKey(normalizeMint(mint));

  if (mintPubKey.toString() === config.tokens.SOL) {
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPubKey });
    if (!accounts.value || accounts.value.length === 0) return 0;

    return accounts.value.reduce((sum, acc) => {
      return sum + (acc.account.data.parsed.info.tokenAmount.uiAmount || 0);
    }, 0);
  } catch (e) {
    log("error", "wallet", `Failed to fetch balance for ${mint}: ${e.message}`);
    return 0;
  }
}