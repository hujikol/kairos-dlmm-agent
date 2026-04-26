/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 *
 * Backed by SQLite (kairos.db).
 */

import { getDB, runTransaction } from "../core/db.js";
import { log } from "../core/logger.js";
import { addrShort } from "../tools/addrShort.js";

// ─── Shared helpers ──────────────────────────────────────────────

/**
 * Ensures a pool_memory row exists for the given address.
 * If not present, inserts a default row with empty aggregates and an empty notes array.
 * Returns the existing or newly-inserted row.
 */
function ensurePoolMemoryExists(poolAddress, name) {
  const db = getDB();
  let row = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress);
  if (!row) {
    db.prepare(`
      INSERT INTO pool_memory (
        pool_address, name, base_mint, total_deploys, avg_pnl_pct, win_rate,
        last_deployed_at, last_outcome, notes, cooldown_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      poolAddress, name || addrShort(poolAddress), null,
      0, 0, 0, null, null, '[]', null
    );
    row = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress);
  }
  return row;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into the database.
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {Object|null} binConfig - { lower_bin, upper_bin, total_bins }
 */
export function recordPoolDeploy(poolAddress, deployData, binConfig) {
  if (!poolAddress) return;
  const db = getDB();

  runTransaction(() => {
    // 1. Ensure pool_memory exists
    const name = deployData.pool_name || addrShort(poolAddress);
    const inputBaseMint = deployData.base_mint || null;
    ensurePoolMemoryExists(poolAddress, name);
    if (inputBaseMint) {
      const cur = db.prepare('SELECT base_mint FROM pool_memory WHERE pool_address = ?').get(poolAddress);
      if (cur && !cur.base_mint) {
        db.prepare('UPDATE pool_memory SET base_mint = ? WHERE pool_address = ?').run(inputBaseMint, poolAddress);
      }
    }

    // 2. Insert the deploy
    const closed_at = deployData.closed_at || new Date().toISOString();
    const pnl_pct = deployData.pnl_pct ?? null;
    db.prepare(`
      INSERT INTO pool_deploys (
        pool_address, deployed_at, closed_at, pnl_pct, pnl_usd, range_efficiency,
        minutes_held, close_reason, strategy, volatility_at_deploy,
        lower_bin, upper_bin, total_bins
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        poolAddress, deployData.deployed_at || null, closed_at, pnl_pct,
        deployData.pnl_usd ?? null, deployData.range_efficiency ?? null,
        deployData.minutes_held ?? null, deployData.close_reason || null,
        deployData.strategy || null, deployData.volatility ?? null,
        binConfig?.lower_bin ?? null,
        binConfig?.upper_bin ?? null,
        binConfig?.total_bins ?? null
    );

    // 3. Update pool_memory aggregates
    const deploys = db.prepare('SELECT pnl_pct FROM pool_deploys WHERE pool_address = ?').all(poolAddress);
    const totalDeploys = deploys.length;
    const withPnl = deploys.filter(d => d.pnl_pct != null);

    let avgPnl = 0;
    let winRate = 0;
    if (withPnl.length > 0) {
      avgPnl = Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100;
      winRate = Math.round((withPnl.filter(d => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100;
    }

    const lastOutcome = (pnl_pct ?? 0) >= 0 ? "profit" : "loss";

    // Fetch latest pool state
    const poolState = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress);
    let notes = [];
    try { notes = JSON.parse(poolState.notes || '[]'); } catch (e) { log("warn", "pool-memory", `Failed to parse pool notes: ${e?.message}`); notes = []; }
    let cooldownUntil = poolState.cooldown_until;

    // ── Smart cooldown: learn from repeat losses ───────────────────
    const recentDeploys = db.prepare('SELECT pnl_pct FROM pool_deploys WHERE pool_address = ? ORDER BY id DESC LIMIT 5').all(poolAddress);
    const recentLosses = recentDeploys.filter(d => (d.pnl_pct ?? 0) < -5);

    let extendedCooldown = false;
    let cooldownHours = 0;
    if (recentLosses.length >= 2) {
      cooldownHours = recentLosses.length >= 3 ? 48 : 12;
      extendedCooldown = true;
      notes.push({
        note: `Auto-blacklisted for ${cooldownHours}h: ${recentLosses.length} losses in last ${recentDeploys.length} deploys`,
        added_at: new Date().toISOString()
      });
      log("info", "pool-memory", `Extended cooldown for ${poolState.name}: ${cooldownHours}h (${recentLosses.length} recent losses)`);
    } else if ((pnl_pct ?? 0) < -15) {
      cooldownHours = 8;
      extendedCooldown = true;
      log("info", "pool-memory", `${cooldownHours}h cooldown for ${poolState.name}: large loss (${pnl_pct}%)`);
    } else if (deployData.close_reason === "low yield" || deployData.close_reason === "low_yield") {
      cooldownHours = 4;
      extendedCooldown = true;
      log("info", "pool-memory", `Cooldown set for ${poolState.name} (low yield close)`);
    }

    if (extendedCooldown) {
      cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();
    }

    let finalBaseMint = poolState.base_mint;
    if (inputBaseMint && !finalBaseMint) finalBaseMint = inputBaseMint;

    db.prepare(`
      UPDATE pool_memory SET
        base_mint = ?, total_deploys = ?, avg_pnl_pct = ?, win_rate = ?,
        last_deployed_at = ?, last_outcome = ?, notes = ?, cooldown_until = ?
      WHERE pool_address = ?
    `).run(
      finalBaseMint, totalDeploys, avgPnl, winRate, closed_at, lastOutcome,
      JSON.stringify(notes), cooldownUntil, poolAddress
    );

    log("info", "pool-memory", `Recorded deploy for ${poolState.name || addrShort(poolAddress)}: PnL ${pnl_pct}%`);
  });
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = getDB();
  const row = db.prepare('SELECT cooldown_until FROM pool_memory WHERE pool_address = ?').get(poolAddress);
  if (!row?.cooldown_until) return false;
  return new Date(row.cooldown_until) > new Date();
}

/**
 * Check if a base token is "toxic" — consistently losing across pools.
 * Returns true if the token has 3+ deploys with >66% loss rate.
 * Used in screening pipeline to avoid repeat losers.
 */
export function isTokenToxic(baseMint) {
  if (!baseMint) return false;
  const db = getDB();
  
  const query = `
    SELECT d.pnl_pct 
    FROM pool_deploys d
    JOIN pool_memory m ON m.pool_address = d.pool_address
    WHERE m.base_mint = ?
  `;
  const deploys = db.prepare(query).all(baseMint);
  
  if (deploys.length < 3) return false;
  
  const losers = deploys.filter(d => (d.pnl_pct ?? 0) < -5).length;
  return (losers / deploys.length) > 0.66;
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = getDB();
  const entry = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(pool_address);

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  const history = db.prepare('SELECT * FROM pool_deploys WHERE pool_address = ? ORDER BY id DESC LIMIT 10').all(pool_address);
  let notes = [];
  try { notes = JSON.parse(entry.notes || '[]'); } catch { /**/ }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    notes,
    history: [...history].reverse(), // chronologically ordered (oldest first among the 10)
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = getDB();

  runTransaction(() => {
    // 1. Ensure pool_memory exists
    ensurePoolMemoryExists(poolAddress, snapshot.pair || addrShort(poolAddress));

    db.prepare(`
      INSERT INTO pool_snapshots (
        pool_address, ts, position, pnl_pct, pnl_usd, in_range, unclaimed_fees_usd,
        minutes_out_of_range, age_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        poolAddress, new Date().toISOString(), snapshot.position || null,
        snapshot.pnl_pct ?? null, snapshot.pnl_usd ?? null, snapshot.in_range ? 1 : 0,
        snapshot.unclaimed_fees_usd ?? null, snapshot.minutes_out_of_range ?? null,
        snapshot.age_minutes ?? null
    );

    // Keep last 48 snapshots
    db.prepare(`
      DELETE FROM pool_snapshots
      WHERE pool_address = ?
      AND id NOT IN (
        SELECT id FROM pool_snapshots WHERE pool_address = ? ORDER BY id DESC LIMIT 48
      )
    `).run(poolAddress, poolAddress);
  });
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = getDB();
  const entry = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress);
  if (!entry) return null;

  const lines = [];

  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  // Recent snapshot trend (last 6)
  const snaps = db.prepare('SELECT * FROM pool_snapshots WHERE pool_address = ? ORDER BY id DESC LIMIT 6').all(poolAddress).reverse();
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === 0).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  let notes = [];
  try { notes = JSON.parse(entry.notes || '[]'); } catch { /**/ }
  if (notes.length > 0) {
    const lastNote = notes[notes.length - 1];
    lines.push(`NOTE: ${lastNote.note}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  if (!note) return { error: "note required" };

  const db = getDB();

  runTransaction(() => {
    const entry = ensurePoolMemoryExists(pool_address, addrShort(pool_address));

    let notes = [];
    try { notes = JSON.parse(entry.notes || '[]'); } catch (e) { log("warn", "pool-memory", `Failed to parse entry notes: ${e?.message}`); notes = []; }

    notes.push({ note, added_at: new Date().toISOString() });

    db.prepare('UPDATE pool_memory SET notes = ? WHERE pool_address = ?').run(JSON.stringify(notes), pool_address);
  });

  log("info", "pool-memory", `Note added to ${addrShort(pool_address)}: ${note}`);
  return { saved: true, pool_address, note };
}

// ─── Bin Learning Queries ────────────────────────────────────────

/**
 * Suggest bin configuration for a pool based on historical winners.
 * Returns null for new pools with no history.
 * @param {string} poolAddress
 * @returns {{ lower_bin: number, upper_bin: number, total_bins: number, sample_size: number } | null}
 */
export function getBinSuggestion(poolAddress) {
  if (!poolAddress) return null;
  const db = getDB();

  // Get top performers (pnl_pct >= 5) for this pool with bin data
  const winners = db.prepare(`
    SELECT lower_bin, upper_bin, total_bins, pnl_pct, range_efficiency
    FROM pool_deploys
    WHERE pool_address = ?
      AND pnl_pct IS NOT NULL
      AND pnl_pct >= 5
      AND lower_bin IS NOT NULL
      AND upper_bin IS NOT NULL
    ORDER BY pnl_pct DESC
    LIMIT 10
  `).all(poolAddress);

  if (winners.length === 0) return null;

  // Use median of winner configs
  const lowerBins = winners.map(w => w.lower_bin).filter(v => v != null).sort((a, b) => a - b);
  const upperBins = winners.map(w => w.upper_bin).filter(v => v != null).sort((a, b) => a - b);
  const totalBins = winners.map(w => w.total_bins).filter(v => v != null).sort((a, b) => a - b);

  if (lowerBins.length === 0 || upperBins.length === 0 || totalBins.length === 0) return null;

  const mid = (arr) => {
    const len = arr.length;
    return len % 2 === 0 ? Math.round((arr[len / 2 - 1] + arr[len / 2]) / 2) : arr[Math.floor(len / 2)];
  };

  return {
    lower_bin: mid(lowerBins),
    upper_bin: mid(upperBins),
    total_bins: mid(totalBins),
    sample_size: winners.length,
  };
}

/**
 * Get bin stats grouped by volatility bucket from historical winners.
 * Used to correlate volatility levels with successful bin widths.
 * @param {number} volatility - Volatility value (0-10 typical)
 * @returns {{ avg_lower_bin: number, avg_upper_bin: number, avg_total_bins: number, win_rate_at_vol: number }}
 */
export function getBinStatsByVolatility(volatility) {
  if (volatility == null) return null;
  const db = getDB();

  // Bucket volatility into 0.5 increments
  const volBucket = Math.round(volatility * 2) / 2;

  const stats = db.prepare(`
    SELECT
      AVG(lower_bin) as avg_lower_bin,
      AVG(upper_bin) as avg_upper_bin,
      AVG(total_bins) as avg_total_bins,
      COUNT(*) as sample_size,
      SUM(CASE WHEN pnl_pct >= 0 THEN 1 ELSE 0 END) as wins
    FROM pool_deploys
    WHERE volatility_at_deploy IS NOT NULL
      AND lower_bin IS NOT NULL
      AND ROUND(volatility_at_deploy * 2) / 2 = ?
  `).get(volBucket);

  if (!stats || stats.sample_size === 0) return null;

  return {
    avg_lower_bin: Math.round(stats.avg_lower_bin || 0),
    avg_upper_bin: Math.round(stats.avg_upper_bin || 0),
    avg_total_bins: Math.round(stats.avg_total_bins || 0),
    win_rate_at_vol: Math.round((stats.wins / stats.sample_size) * 100),
    sample_size: stats.sample_size,
  };
}
