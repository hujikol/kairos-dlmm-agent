/**
 * Position Registry — position CRUD for the local SQLite registry.
 * All functions share the same getDB() from ../db.js.
 */

import { getDB, runTransaction } from "../db.js";
import { log } from "../logger.js";
import { addrShort } from "../../tools/addrShort.js";
import { pushEvent } from "./events.js";

// ─── Internal helpers ────────────────────────────────────────────────────────

export function updatePosition(position_address, updates) {
  const db = getDB();
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setCols = keys.map(k => `${k} = ?`).join(", ");
  const values = keys.map(k => updates[k]);
  values.push(position_address);
  db.prepare(`UPDATE positions SET ${setCols} WHERE position = ?`).run(...values);
  touchLastUpdated();
}

function touchLastUpdated() {
  const db = getDB();
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run("lastUpdated", new Date().toISOString());
}

export function appendNote(position_address, note) {
  const db = getDB();
  const pos = db.prepare("SELECT notes FROM positions WHERE position = ?").get(position_address);
  if (!pos) return;
  let notes = [];
  try { notes = JSON.parse(pos.notes || "[]"); } catch (e) {
    log("warn", "state", `Failed to parse position notes: ${e?.message}`);
    notes = [];
  }
  notes.push(note);
  updatePosition(position_address, { notes: JSON.stringify(notes) });
}

function rowToPos(row) {
  return {
    ...row,
    bin_range: JSON.parse(row.bin_range || "{}"),
    signal_snapshot: JSON.parse(row.signal_snapshot || "null"),
    notes: JSON.parse(row.notes || "[]"),
    closed: row.closed === 1,
    trailing_active: row.trailing_active === 1,
  };
}

// ─── KV Store ───────────────────────────────────────────────────────────────

function setKV(key, value) {
  const db = getDB();
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run(key, value);
}

function getKV(key) {
  const db = getDB();
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  return row ? row.value : null;
}

export { touchLastUpdated };

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a newly deployed position in the local SQLite registry.
 * @param {Object} opts - Position details
 * @param {string} opts.position - On-chain position address
 * @param {string} opts.pool - Pool address
 * @param {string} [opts.pool_name] - Human-readable pool name
 * @param {string} [opts.strategy] - Strategy used (e.g. "bid_ask")
 * @param {Object} [opts.bin_range] - { lower, upper } bin IDs
 * @param {number} opts.amount_sol - SOL amount deployed
 * @param {number} [opts.amount_x] - Token-X amount (if two-sided)
 * @param {number} [opts.active_bin] - Active bin ID at deploy time
 * @param {number} [opts.bin_step] - Pool bin step (basis points)
 * @param {number} [opts.volatility] - Pool volatility score
 * @param {number} [opts.fee_tvl_ratio] - Fee/TVL ratio at deploy
 * @param {number} [opts.organic_score] - Organic score (0-100)
 * @param {number} [opts.initial_value_usd] - Initial USD value of position
 * @param {Object} [opts.signal_snapshot] - Signal data at deploy time
 * @param {string} [opts.base_mint] - Base token mint address
 * @param {string} [opts.market_phase] - Market phase at deploy
 * @param {string} [opts.strategy_id] - Strategy identifier
 * @returns {void}
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
  market_phase = null,
  strategy_id = null,
}) {
  const db = getDB();

  runTransaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO positions (
        position, pool, pool_name, strategy, bin_range, amount_sol, amount_x,
        active_bin_at_deploy, bin_step, volatility, fee_tvl_ratio,
        organic_score, initial_value_usd, signal_snapshot, base_mint, deployed_at,
        out_of_range_since, last_claim_at, total_fees_claimed_usd, rebalance_count,
        closed, closed_at, notes, peak_pnl_pct, prev_pnl_pct, trailing_active, instruction, status, market_phase, strategy_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      position, pool, pool_name, strategy, JSON.stringify(bin_range), amount_sol, amount_x,
      active_bin, bin_step, volatility, fee_tvl_ratio,
      organic_score, initial_value_usd, JSON.stringify(signal_snapshot || null), base_mint, new Date().toISOString(),
      null, null, 0, 0,
      0, null, "[]", 0, null, 0, null, "pending", market_phase, strategy_id,
    );

    pushEvent({ action: "deploy", position, pool_name: pool_name || pool });
    touchLastUpdated();
  });

  log("info", "state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Update position status: 'pending' -> 'active' -> 'closed'.
 */
export function updatePositionStatus(position_address, status) {
  const db = getDB();
  db.prepare("UPDATE positions SET status = ? WHERE position = ?").run(status, position_address);
  log("info", "state", `Position ${addrShort(position_address)} status -> ${status}`);
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const db = getDB();
  const pos = db.prepare("SELECT pool, pool_name FROM positions WHERE position = ?").get(position_address);
  if (!pos) return;

  const closed_at = new Date().toISOString();

  runTransaction(() => {
    updatePosition(position_address, { closed: 1, closed_at });
    appendNote(position_address, `Closed at ${closed_at}: ${reason}`);
    pushEvent({ action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  });
  log("info", "state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const db = getDB();
  runTransaction(() => {
    const old = db.prepare("SELECT rebalance_count FROM positions WHERE position = ?").get(old_position);
    if (old) {
      const closed_at = new Date().toISOString();
      updatePosition(old_position, { closed: 1, closed_at });
      appendNote(old_position, `Rebalanced into ${new_position} at ${closed_at}`);
    }

    const newPos = db.prepare("SELECT * FROM positions WHERE position = ?").get(new_position);
    if (newPos) {
      updatePosition(new_position, { rebalance_count: (old?.rebalance_count || 0) + 1 });
      appendNote(new_position, `Rebalanced from ${old_position}`);
    }
  });
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const db = getDB();
  const pos = db.prepare("SELECT total_fees_claimed_usd FROM positions WHERE position = ?").get(position_address);
  if (!pos) return;

  const last_claim_at = new Date().toISOString();
  const total = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);

  runTransaction(() => {
    updatePosition(position_address, { last_claim_at, total_fees_claimed_usd: total });
    appendNote(position_address, `Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${last_claim_at}`);
  });
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const db = getDB();
  const pos = db.prepare("SELECT position FROM positions WHERE position = ?").get(position_address);
  if (!pos) return false;

  updatePosition(position_address, { instruction: instruction || null });
  log("info", "state", `Position ${position_address} instruction set: ${instruction}`);
  return true;
}

/**
 * Get all tracked positions from SQLite, optionally filtered to open positions only.
 * @param {boolean} [openOnly=false] - If true, return only open (non-closed) positions
 * @returns {Array<Object>} Array of position objects with bin_range, notes, etc. parsed from JSON
 */
export function getTrackedPositions(openOnly = false) {
  const db = getDB();
  const rows = openOnly
    ? db.prepare("SELECT * FROM positions WHERE closed = 0").all()
    : db.prepare("SELECT * FROM positions").all();
  return rows.map(rowToPos);
}

/**
 * Get a single tracked position.
 */
let _trackedPositionOverride = null;

export function _injectTrackedPosition(pos) {
  _trackedPositionOverride = pos;
}

export function getTrackedPosition(position_address) {
  if (_trackedPositionOverride && _trackedPositionOverride.position === position_address) {
    return _trackedPositionOverride;
  }
  const db = getDB();
  const row = db.prepare("SELECT * FROM positions WHERE position = ?").get(position_address);
  return row ? rowToPos(row) : null;
}

// ─── Briefing KV helpers (re-exported from registry for backward compat) ─────

export { getKV as getLastBriefingDate };

export function setLastBriefingDate() {
  setKV("_lastBriefingDate", new Date().toISOString().slice(0, 10)); // YYYY-MM-DD UTC
  touchLastUpdated();
}

// ─── State summary (used by agent/React) ──────────────────────────────────────

export function getStateSummary() {
  const db = getDB();
  const openRows = db.prepare("SELECT * FROM positions WHERE closed = 0").all();
  const counts = db.prepare("SELECT SUM(closed) as closed_count FROM positions").get();

  const feesAgg = db.prepare("SELECT SUM(total_fees_claimed_usd) as t FROM positions").get();

  const posArray = openRows.map(rowToPos);

  const events = db.prepare("SELECT * FROM recent_events ORDER BY id DESC LIMIT 10").all().reverse();

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
      fee_tvl_ratio: p.fee_tvl_ratio,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: getKV("lastUpdated"),
    recent_events: events,
  };
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const db = getDB();
  const pos = db.prepare("SELECT out_of_range_since FROM positions WHERE position = ?").get(position_address);
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}
