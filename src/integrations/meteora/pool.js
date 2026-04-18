import {
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getConnection as getRpcConnection } from "../solana.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../../config.js";
import { createCircuitBreaker, CircuitOpenError } from "../../core/circuit-breaker.js";
import { addrShort } from "../../tools/addrShort.js";
import { log } from "../../core/logger.js";
import { isPoolOnCooldown } from "../../features/pool-memory.js";
import { normalizeMint } from "../helius/normalize.js";
import { poolCache } from "../../core/cache-manager.js";

// Meteora DLMM API breaker — protects pool search + active bin lookups
const meteoraPool = createCircuitBreaker("meteoraPool", {
  failureThreshold:  5,
  recoveryTimeoutMs: 60_000,
  halfOpenProbes:    3,
});

// ─── Constants ───────────────────────────────────────────────────
/** Meteora DLMM program ID (LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo) */
export const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// ─── Lazy SDK loader ───────────────────────────────────────────
let _DLMM = null;
let _StrategyType = null;

export async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

// ─── Lazy wallet/connection init ──────────────────────────────
let _wallet = null;

export function getConnection() {
  return getRpcConnection("confirmed");
}

export function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("info", "init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// ─── Priority Fee Helper ──────────────────────────────────────────

/**
 * Prepend compute budget instructions to a transaction for better reliability.
 * Micro-lamports configurable via PRIORITY_MICRO_LAMPORTS env var.
 */
export function applyPriorityFee(tx) {
  const microLamports = parseInt(process.env.PRIORITY_MICRO_LAMPORTS || "50000");
  tx.instructions = tx.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId)
  );
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: parseInt(process.env.METEORA_COMPUTE_UNIT_LIMIT || "1400000") })
  );
  return tx;
}

// ─── Shared Send with Priority Fee ──────────────────────────────

/**
 * Send a transaction with compute budget instructions prepended.
 * All on-chain sends should go through this.
 */
let _sendTxOverride = null;

export function _injectSendTx(fn) {
  _sendTxOverride = fn;
}

export async function sendTx(tx, signers) {
  if (_sendTxOverride) return _sendTxOverride(tx, signers);
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const txCopy = applyPriorityFee(tx);
      return await sendAndConfirmTransaction(getConnection(), txCopy, signers);
    } catch (err) {
      const isRetryable = err.name === "SendTransactionError"
        || err.message?.includes("Blockhash not found")
        || err.message?.includes("block height exceeded")
        || err.message?.includes("timeout")
        || err.message?.includes("429");
      if (!isRetryable || attempt === maxRetries) throw err;
      const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
      log("warn", "tx", `sendTx attempt ${attempt}/${maxRetries} failed: ${err.message} — retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
// 10 minutes — no shared constant exists in core/constants.js for this TTL
const POOL_CACHE_TTL_MS = 10 * 60 * 1000;

// ─── Test injection hook ────────────────────────────────────────

export function _injectPool(pool) {
  if (pool) {
    poolCache.setForTesting("testOverride", pool);
  } else {
    poolCache.delete("testOverride");
  }
}

export async function getPool(poolAddress, { invalidate = false, poolOverride } = {}) {
  if (meteoraPool.isOpen()) throw new CircuitOpenError("meteoraPool");
  const key = poolAddress.toString();
  if (invalidate) {
    poolCache.delete(key);
    return;
  }

  // Test override check
  const testOverride = poolCache.get("testOverride");
  if (testOverride !== undefined) {
    return testOverride;
  }

  // Cache lookup — CacheManager handles TTL expiry internally
  const cached = poolCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool, POOL_CACHE_TTL_MS);
    meteoraPool.recordSuccess();
    return pool;
  } catch (err) {
    meteoraPool.recordFailure();
    throw err;
  }
}

/**
 * Get the current active bin for a Meteora DLMM pool.
 * @param {Object} opts - Parameters
 * @param {string} opts.pool_address - Pool address
 * @returns {Promise<Object>} { binId, price, pricePerLamport }
 */
export async function getActiveBin({ pool_address }) {
  if (meteoraPool.isOpen()) throw new CircuitOpenError("meteoraPool");
  pool_address = normalizeMint(pool_address);
  let pool;
  try {
    pool = await getPool(pool_address);
  } catch (err) {
    if (err instanceof CircuitOpenError) throw err;
    meteoraPool.recordFailure();
    throw err;
  }
  let activeBin;
  try {
    activeBin = await pool.getActiveBin();
  } catch (err) {
    meteoraPool.recordFailure();
    throw err;
  }
  meteoraPool.recordSuccess();
  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

/**
 * Search Meteora DLMM pools by token query string.
 * @param {Object} opts - Parameters
 * @param {string} opts.query - Search query (token symbol or pool name)
 * @param {number} [opts.limit=10] - Maximum number of results
 * @returns {Promise<Object>} { query, total, pools: [{ pool, name, bin_step, fee_pct, tvl, volume_24h, token_x: { symbol, mint }, token_y: { symbol, mint } }, ...] }
 */
export async function searchPools({ query, limit = 10 }) {
  if (meteoraPool.isOpen()) throw new CircuitOpenError("meteoraPool");
  const url = `${process.env.METEORA_DLMM_API_BASE || "https://dlmm.datapi.meteora.ag"}/pools?query=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    meteoraPool.recordFailure();
    throw err;
  }
  if (!res.ok) {
    meteoraPool.recordFailure();
    throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  }
  meteoraPool.recordSuccess();
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Helper: lookup pool for a position ─────────────────────────

/**
 * Resolve the pool address for a given position.
 * Checks (1) tracked state, (2) positions cache, (3) SDK scan as last resort.
 * @param {string} position_address
 * @param {string} walletAddress
 * @param {Object} [positionsCache] - Optional positions cache from positions.js
 * @returns {Promise<string>}
 */
export async function lookupPoolForPosition(position_address, walletAddress, positionsCache) {
  const tracked = (await import("../../core/state/index.js")).getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  const cached = positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  // Search the SDK scan result for the position's pool address.
  // getAllLbPairPositionsByUser returns Map<string, {lbPair, positionData[]}> or Array.
  const entries = allPositions instanceof Map
    ? [...allPositions.entries()]
    : Array.isArray(allPositions)
      ? allPositions.map(e => [e.lbPair?.toString?.() || e.poolAddress, e])
      : [];

  for (const [poolKey, entry] of entries) {
    // Check positionData array (Map-based SDK response)
    const posDataArr = entry?.positionData ?? entry?.positions ?? [];
    for (const pos of (Array.isArray(posDataArr) ? posDataArr : [])) {
      const pk = pos.publicKey?.toString?.() || pos.positionAddress || pos.address;
      if (pk === position_address) {
        const resolvedPool = poolKey?.toString?.() || entry?.lbPair?.toString?.();
        if (resolvedPool) {
          log("info", "pool", `lookupPoolForPosition: found ${position_address} in pool ${resolvedPool} via SDK scan`);
          return resolvedPool;
        }
      }
    }
    // Check top-level publicKey (Array-based SDK response)
    const topKey = entry?.publicKey?.toString?.() || entry?.positionAddress;
    if (topKey === position_address) {
      const resolvedPool = poolKey?.toString?.() || entry?.lbPair?.toString?.();
      if (resolvedPool) {
        log("info", "pool", `lookupPoolForPosition: found ${position_address} in pool ${resolvedPool} via SDK scan`);
        return resolvedPool;
      }
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
