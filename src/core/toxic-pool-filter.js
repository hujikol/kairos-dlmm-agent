import { getDB } from "./db.js";
import { LRUCache } from "../utils/lru-cache.js";

const recentRugCache = new LRUCache(200);

export function isToxicPool(poolAddress) {
  if (recentRugCache.has(poolAddress)) return true;
  const db = getDB();
  const deploys = db.prepare(`
    SELECT pd.pnl_pct
    FROM pool_deploys pd
    WHERE pd.pool_address = ?
    ORDER BY pd.deployed_at DESC
    LIMIT 5
  `).all(poolAddress);
  if (deploys.length === 0) return false;
  const losses = deploys.filter(d => (d.pnl_pct ?? 0) < 0);
  const lossRate = losses.length / deploys.length;
  const avgPnl = deploys.reduce((s, d) => s + (d.pnl_pct ?? 0), 0) / deploys.length;
  const worstPnl = Math.min(...deploys.map(d => d.pnl_pct ?? 0));
  if (losses.length >= 2) return true;
  if (lossRate > 0.66 && deploys.length >= 3) return true;
  if (deploys.length >= 2 && avgPnl < -70) return true;
  if (worstPnl < -90) return true;
  return false;
}

export function markPoolAsRug(poolAddress) {
  recentRugCache.set(poolAddress, true);
}

export function getRecentRugPools() {
  return Array.from(recentRugCache.keys());
}