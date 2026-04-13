import { getDB } from "../core/db.js";
import { log } from "../core/logger.js";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({ name, address }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const db = getDB();
  const existing = db.prepare('SELECT name FROM smart_wallets WHERE address = ?').get(address);
  if (existing) {
    return { success: false, error: `Already tracks as "${existing.name}"` };
  }
  db.prepare('INSERT INTO smart_wallets (address, name, added_at) VALUES (?, ?, ?)').run(
    address, name, new Date().toISOString()
  );
  log("info", "smart_wallets", `Added wallet: ${name}`);
  return { success: true, wallet: { name, address } };
}

export function removeSmartWallet({ address }) {
  const db = getDB();
  const wallet = db.prepare('SELECT name FROM smart_wallets WHERE address = ?').get(address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  db.prepare('DELETE FROM smart_wallets WHERE address = ?').run(address);
  log("info", "smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets() {
  const db = getDB();
  const wallets = db.prepare('SELECT * FROM smart_wallets ORDER BY added_at').all();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool({ pool_address }) {
  const allWallets = listSmartWallets().wallets;
  if (allWallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("../integrations/meteora.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        const { positions } = await getWalletPositions({ wallet_address: wallet.address });
        _cache.set(wallet.address, { positions: positions || [], fetchedAt: Date.now() });
        return { wallet, positions: positions || [] };
      } catch (e) { log("warn", "smart-wallets", `Failed to get positions for ${wallet}: ${e?.message}`); return { wallet, positions: [] }; }
    })
  );

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}
