/**
 * Persistent agent state — stored in SQLite (meridian.db).
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import { getDB } from "../db.js";
import { log } from "../logger.js";

const MAX_RECENT_EVENTS = 20;

// ─── KV Store Helpers ──────────────────────────────────────────

function setKV(key, value) {
  const db = getDB();
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run(key, value);
}

function getKV(key) {
  const db = getDB();
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function touchLastUpdated() {
  setKV('lastUpdated', new Date().toISOString());
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  base_mint = null,
}) {
  const db = getDB();

  db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO positions (
        position, pool, pool_name, strategy, bin_range, amount_sol, amount_x,
        active_bin_at_deploy, bin_step, volatility, fee_tvl_ratio, initial_fee_tvl_24h,
        organic_score, initial_value_usd, signal_snapshot, base_mint, deployed_at,
        out_of_range_since, last_claim_at, total_fees_claimed_usd, rebalance_count,
        closed, closed_at, notes, peak_pnl_pct, trailing_active, instruction, status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      position, pool, pool_name, strategy, JSON.stringify(bin_range), amount_sol, amount_x,
      active_bin, bin_step, volatility, fee_tvl_ratio, fee_tvl_ratio,
      organic_score, initial_value_usd, JSON.stringify(signal_snapshot || null), base_mint, new Date().toISOString(),
      null, null, 0, 0,
      0, null, '[]', 0, 0, null, 'pending'
    );

    pushEvent({ action: "deploy", position, pool_name: pool_name || pool });
    touchLastUpdated();
  })();
  
  log("info", "state", `Tracked new position: ${position} in pool ${pool}`);
}

function updatePosition(position_address, updates) {
  const db = getDB();
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setCols = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  values.push(position_address);

  db.prepare(`UPDATE positions SET ${setCols} WHERE position = ?`).run(...values);
  touchLastUpdated();
}

/**
 * Update position status: 'pending' -> 'active' -> 'closed'.
 */
export function updatePositionStatus(position_address, status) {
  const db = getDB();
  db.prepare('UPDATE positions SET status = ? WHERE position = ?').run(status, position_address);
  log("info", "state", `Position ${position_address.slice(0,8)} status -> ${status}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const db = getDB();
  const pos = db.prepare('SELECT out_of_range_since FROM positions WHERE position = ?').get(position_address);
  if (pos && !pos.out_of_range_since) {
    updatePosition(position_address, { out_of_range_since: new Date().toISOString() });
    log("info", "state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const db = getDB();
  const pos = db.prepare('SELECT out_of_range_since FROM positions WHERE position = ?').get(position_address);
  if (pos && pos.out_of_range_since) {
    updatePosition(position_address, { out_of_range_since: null });
    log("info", "state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const db = getDB();
  const pos = db.prepare('SELECT out_of_range_since FROM positions WHERE position = ?').get(position_address);
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

function appendNote(position_address, note) {
  const db = getDB();
  const pos = db.prepare('SELECT notes FROM positions WHERE position = ?').get(position_address);
  if (!pos) return;
  let notes = [];
  try { notes = JSON.parse(pos.notes || '[]'); } catch { notes = []; }
  notes.push(note);
  updatePosition(position_address, { notes: JSON.stringify(notes) });
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const db = getDB();
  const pos = db.prepare('SELECT total_fees_claimed_usd FROM positions WHERE position = ?').get(position_address);
  if (!pos) return;
  
  const last_claim_at = new Date().toISOString();
  const total = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  
  db.transaction(() => {
    updatePosition(position_address, { last_claim_at, total_fees_claimed_usd: total });
    appendNote(position_address, `Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${last_claim_at}`);
  })();
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(event) {
  const db = getDB();
  db.transaction(() => {
    db.prepare('INSERT INTO recent_events (ts, action, position, pool_name, reason) VALUES (?, ?, ?, ?, ?)').run(
      new Date().toISOString(), event.action, event.position, event.pool_name, event.reason || null
    );
    // Keep max 20
    db.prepare(`
      DELETE FROM recent_events WHERE id NOT IN (
        SELECT id FROM recent_events ORDER BY id DESC LIMIT ?
      )
    `).run(MAX_RECENT_EVENTS);
  })();
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const db = getDB();
  const pos = db.prepare('SELECT pool, pool_name FROM positions WHERE position = ?').get(position_address);
  if (!pos) return;
  
  const closed_at = new Date().toISOString();
  
  db.transaction(() => {
    updatePosition(position_address, { closed: 1, closed_at });
    appendNote(position_address, `Closed at ${closed_at}: ${reason}`);
    pushEvent({ action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  })();
  log("info", "state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const db = getDB();
  db.transaction(() => {
    const old = db.prepare('SELECT rebalance_count FROM positions WHERE position = ?').get(old_position);
    if (old) {
      const closed_at = new Date().toISOString();
      updatePosition(old_position, { closed: 1, closed_at });
      appendNote(old_position, `Rebalanced into ${new_position} at ${closed_at}`);
    }
    
    const newPos = db.prepare('SELECT * FROM positions WHERE position = ?').get(new_position);
    if (newPos) {
      updatePosition(new_position, { rebalance_count: (old?.rebalance_count || 0) + 1 });
      appendNote(new_position, `Rebalanced from ${old_position}`);
    }
  })();
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const db = getDB();
  const pos = db.prepare('SELECT position FROM positions WHERE position = ?').get(position_address);
  if (!pos) return false;
  
  updatePosition(position_address, { instruction: instruction || null });
  log("info", "state", `Position ${position_address} instruction set: ${instruction}`);
  return true;
}

function rowToPos(row) {
  return {
    ...row,
    bin_range: JSON.parse(row.bin_range || '{}'),
    signal_snapshot: JSON.parse(row.signal_snapshot || 'null'),
    notes: JSON.parse(row.notes || '[]'),
    closed: row.closed === 1,
    trailing_active: row.trailing_active === 1
  };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const db = getDB();
  const rows = openOnly 
    ? db.prepare('SELECT * FROM positions WHERE closed = 0').all()
    : db.prepare('SELECT * FROM positions').all();
  return rows.map(rowToPos);
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const db = getDB();
  const row = db.prepare('SELECT * FROM positions WHERE position = ?').get(position_address);
  return row ? rowToPos(row) : null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const db = getDB();
  const openRows = db.prepare('SELECT * FROM positions WHERE closed = 0').all();
  const counts = db.prepare(`SELECT SUM(closed) as closed_count FROM positions`).get();
  
  // total fees claimed
  const feesAgg = db.prepare('SELECT SUM(total_fees_claimed_usd) as t FROM positions').get();

  const posArray = openRows.map(rowToPos);

  const events = db.prepare('SELECT * FROM recent_events ORDER BY id DESC LIMIT 10').all().reverse();

  return {
    open_positions: openRows.length,
    closed_positions: counts.closed_count || 0,
    total_fees_claimed_usd: Math.round((feesAgg.t || 0) * 100) / 100,
    positions: posArray.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: getKV('lastUpdated'),
    recent_events: events,
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, in_range, fee_per_tvl_24h } = positionData;
  const pos = getTrackedPosition(position_address);
  
  if (!pos || pos.closed) return null;

  let updates = {};
  let changed = false;

  // Track peak PnL
  if (currentPnlPct != null && currentPnlPct > (pos.peak_pnl_pct ?? 0)) {
    updates.peak_pnl_pct = currentPnlPct;
    pos.peak_pnl_pct = currentPnlPct;
    changed = true;
  }

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && currentPnlPct >= mgmtConfig.trailingTriggerPct) {
    updates.trailing_active = 1;
    pos.trailing_active = true;
    changed = true;
    log("info", "state", `Position ${position_address} trailing TP activated at ${currentPnlPct}% (peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    updates.out_of_range_since = new Date().toISOString();
    pos.out_of_range_since = updates.out_of_range_since;
    changed = true;
    log("info", "state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    updates.out_of_range_since = null;
    pos.out_of_range_since = null;
    changed = true;
    log("info", "state", `Position ${position_address} back in range`);
  }

  if (changed) updatePosition(position_address, updates);

  // ── Volatility-adaptive adjustments ────────────────────────────
  const vol = pos.volatility ?? 3;
  const oorWait = vol >= 7
    ? Math.round(mgmtConfig.outOfRangeWaitMinutes * 0.5)
    : vol >= 4
    ? Math.round(mgmtConfig.outOfRangeWaitMinutes * 0.75)
    : mgmtConfig.outOfRangeWaitMinutes;

  const adaptiveTrailingDrop = vol >= 7
    ? mgmtConfig.trailingDropPct * 1.5 
    : mgmtConfig.trailingDropPct;

  // ── Stop loss ──────────────────────────────────────────────────
  if (currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= adaptiveTrailingDrop) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${adaptiveTrailingDrop.toFixed(1)}%${vol >= 7 ? " [vol-adaptive]" : ""})`,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= oorWait) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${oorWait}m${vol >= 4 ? ` [vol-adaptive from ${mgmtConfig.outOfRangeWaitMinutes}m]` : ""})`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

export function getLastBriefingDate() {
  return getKV("_lastBriefingDate");
}

export function setLastBriefingDate() {
  setKV("_lastBriefingDate", new Date().toISOString().slice(0, 10)); // YYYY-MM-DD UTC
  touchLastUpdated();
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000;

export function syncOpenPositions(active_addresses) {
  const db = getDB();
  const activeSet = new Set(active_addresses);
  const openPos = db.prepare('SELECT position, deployed_at FROM positions WHERE closed = 0').all();

  db.transaction(() => {
    for (const pos of openPos) {
      if (activeSet.has(pos.position)) continue;

      const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
      if (Date.now() - deployedAt < SYNC_GRACE_MS) {
        log("info", "state", `Position ${pos.position} not on-chain yet — within grace period, skipping auto-close`);
        continue;
      }

      const closed_at = new Date().toISOString();
      updatePosition(pos.position, { closed: 1, closed_at });
      appendNote(pos.position, `Auto-closed during state sync (not found on-chain)`);
      log("info", "state", `Position ${pos.position} auto-closed (missing from on-chain data)`);
    }
  })();
}
