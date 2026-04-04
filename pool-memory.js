/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 *
 * Backed by SQLite (meridian.db).
 */

import { getDB } from "./db.js";
import { log } from "./logger.js";

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into the database.
 * Called automatically from recordPerformance() in lessons.js.
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;
  const db = getDB();

  db.transaction(() => {
    // 1. Ensure pool_memory exists
    const existing = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress);
    if (!existing) {
      db.prepare(`
        INSERT INTO pool_memory (
          pool_address, name, base_mint, total_deploys, avg_pnl_pct, win_rate,
          last_deployed_at, last_outcome, notes, cooldown_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        poolAddress, deployData.pool_name || poolAddress.slice(0, 8), deployData.base_mint || null,
        0, 0, 0, null, null, '[]', null
      );
    }

    // 2. Insert the deploy
    const closed_at = deployData.closed_at || new Date().toISOString();
    const pnl_pct = deployData.pnl_pct ?? null;
    db.prepare(`
      INSERT INTO pool_deploys (
        pool_address, deployed_at, closed_at, pnl_pct, pnl_usd, range_efficiency,
        minutes_held, close_reason, strategy, volatility_at_deploy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        poolAddress, deployData.deployed_at || null, closed_at, pnl_pct,
        deployData.pnl_usd ?? null, deployData.range_efficiency ?? null,
        deployData.minutes_held ?? null, deployData.close_reason || null,
        deployData.strategy || null, deployData.volatility ?? null
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
    try { notes = JSON.parse(poolState.notes || '[]'); } catch { notes = []; }
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
      log("pool-memory", `Extended cooldown for ${poolState.name}: ${cooldownHours}h (${recentLosses.length} recent losses)`);
    } else if ((pnl_pct ?? 0) < -15) {
      cooldownHours = 8;
      extendedCooldown = true;
      log("pool-memory", `${cooldownHours}h cooldown for ${poolState.name}: large loss (${pnl_pct}%)`);
    } else if (deployData.close_reason === "low yield" || deployData.close_reason === "low_yield") {
      cooldownHours = 4;
      extendedCooldown = true;
      log("pool-memory", `Cooldown set for ${poolState.name} (low yield close)`);
    }

    if (extendedCooldown) {
      cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();
    }

    let baseMint = poolState.base_mint;
    if (deployData.base_mint && !baseMint) baseMint = deployData.base_mint;
    
    db.prepare(`
      UPDATE pool_memory SET
        base_mint = ?, total_deploys = ?, avg_pnl_pct = ?, win_rate = ?,
        last_deployed_at = ?, last_outcome = ?, notes = ?, cooldown_until = ?
      WHERE pool_address = ?
    `).run(
      baseMint, totalDeploys, avgPnl, winRate, closed_at, lastOutcome,
      JSON.stringify(notes), cooldownUntil, poolAddress
    );

    log("pool-memory", `Recorded deploy for ${poolState.name || poolAddress.slice(0, 8)}: PnL ${pnl_pct}%`);
  })();
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
    history: history.reverse(), // chronologically ordered (oldest first among the 10)
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = getDB();

  db.transaction(() => {
    // 1. Ensure pool_memory exists
    const existing = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress);
    if (!existing) {
      db.prepare(`
        INSERT INTO pool_memory (
          pool_address, name, base_mint, total_deploys, avg_pnl_pct, win_rate,
          last_deployed_at, last_outcome, notes, cooldown_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        poolAddress, snapshot.pair || poolAddress.slice(0, 8), null,
        0, 0, 0, null, null, '[]', null
      );
    }

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
  })();
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

  db.transaction(() => {
    let entry = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(pool_address);
    if (!entry) {
      db.prepare(`
        INSERT INTO pool_memory (
          pool_address, name, base_mint, total_deploys, avg_pnl_pct, win_rate,
          last_deployed_at, last_outcome, notes, cooldown_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pool_address, pool_address.slice(0, 8), null, 0, 0, 0, null, null, '[]', null
      );
      entry = { notes: '[]' };
    }

    let notes = [];
    try { notes = JSON.parse(entry.notes || '[]'); } catch { notes = []; }
    
    notes.push({ note, added_at: new Date().toISOString() });
    
    db.prepare('UPDATE pool_memory SET notes = ? WHERE pool_address = ?').run(JSON.stringify(notes), pool_address);
  })();

  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${note}`);
  return { saved: true, pool_address, note };
}
