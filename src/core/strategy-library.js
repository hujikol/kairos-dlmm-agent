/**
 * Strategy Library — persistent store of LP strategies.
 *
 * Users paste a tweet or description via Telegram.
 * The agent extracts structured criteria and saves it here.
 * During screening, the active strategy's criteria guide token selection and position config.
 */

import { getDB } from "./db.js";
import { log } from "./logger.js";

// ─── Default Strategies ─────────────────────────────────────────
const DEFAULT_STRATEGIES = {
  custom_ratio_spot: {
    id: "custom_ratio_spot",
    name: "Custom Ratio Spot",
    author: "meridian",
    lp_strategy: "spot",
    token_criteria: { notes: "Any token. Ratio expresses directional bias." },
    entry: { condition: "Directional view on token", single_side: null, notes: "75% token = bullish (sell on pump out of range). 75% SOL = bearish/DCA-in (buy on dip). Set bins_below:bins_above proportional to ratio." },
    range: { type: "custom", notes: "bins_below:bins_above ratio matches token:SOL ratio. E.g., 75% token → ~52 bins below, ~17 bins above." },
    exit: { take_profit_pct: 10, notes: "Close when OOR or TP hit. Re-deploy with updated ratio based on new momentum signals." },
    best_for: "Expressing directional bias while earning fees both ways",
  },
  single_sided_reseed: {
    id: "single_sided_reseed",
    name: "Single-Sided Bid-Ask + Re-seed",
    author: "meridian",
    lp_strategy: "bid_ask",
    token_criteria: { notes: "Volatile tokens with strong narrative. Must have active volume." },
    entry: { condition: "Deploy token-only (amount_x only, amount_y=0) bid-ask, bins below active bin only", single_side: "token", notes: "As price drops through bins, token sold for SOL. Bid-ask concentrates at bottom edge." },
    range: { type: "default", bins_below_pct: 100, notes: "All bins below active bin. bins_above=0." },
    exit: { notes: "When OOR downside: close_position(skip_swap=true) → redeploy token-only bid-ask at new lower price. Do NOT swap to SOL. Full close only when token dead or after N re-seeds with declining performance." },
    best_for: "Riding volatile tokens down without cutting losses. DCA out via LP.",
  },
  fee_compounding: {
    id: "fee_compounding",
    name: "Fee Compounding",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "Stable volume pools with consistent fee generation." },
    entry: { condition: "Deploy normally with any shape", notes: "Strategy is about management, not entry shape." },
    range: { type: "default", notes: "Standard range for the pair." },
    exit: { notes: "When unclaimed fees > $5 AND in range: claim_fees → add_liquidity back into same position. Normal close rules otherwise." },
    best_for: "Maximizing yield on stable, range-bound pools via compounding",
  },
  multi_layer: {
    id: "multi_layer",
    name: "Multi-Layer",
    author: "meridian",
    lp_strategy: "mixed",
    token_criteria: { notes: "High volume pools. Layer multiple shapes into ONE position via addLiquidityByStrategy to sculpt a composite distribution." },
    entry: {
      condition: "Create ONE position, then layer additional shapes onto it with add-liquidity. Each layer adds a different strategy/shape to the same position, compositing them.",
      notes: "Step 1: deploy (creates position with first shape). Step 2+: add-liquidity to same position with different shapes. All layers share the same bin range but different distribution curves stack on top of each other.",
      example_patterns: {
        smooth_edge: "Deploy Bid-Ask (edges) → add-liquidity Spot (fills the middle gap). 2 layers, 1 position.",
        full_composite: "Deploy Bid-Ask (edges) → add-liquidity Spot (middle) → add-liquidity Curve (center boost). 3 layers, 1 position.",
        edge_heavy: "Deploy Bid-Ask → add-liquidity Bid-Ask again (double edge weight). 2 layers, 1 position.",
      },
    },
    range: { type: "custom", notes: "All layers share the position's bin range (set at deploy). Choose range wide enough for the widest layer needed." },
    exit: { notes: "Single position — one close, one claim. The composite shape means fees earned reflect ALL layers combined." },
    best_for: "Creating custom liquidity distributions by stacking shapes in one position. Single position to manage.",
  },
  partial_harvest: {
    id: "partial_harvest",
    name: "Partial Harvest",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "High fee pools where taking profit incrementally is preferred." },
    entry: { condition: "Deploy normally", notes: "Strategy is about progressive profit-taking, not entry." },
    range: { type: "default", notes: "Standard range." },
    exit: { take_profit_pct: 10, notes: "When total return >= 10% of deployed capital: withdraw_liquidity(bps=5000) to take 50% off. Remaining 50% keeps running. Repeat at next threshold." },
    best_for: "Locking in profits without fully exiting winning positions",
  },
};

function ensureDefaultStrategies() {
  const db = getDB();
  const count = db.prepare('SELECT COUNT(*) as c FROM strategies').get().c;
  if (count === 0) {
    db.transaction(() => {
      for (const [id, s] of Object.entries(DEFAULT_STRATEGIES)) {
        db.prepare(`
          INSERT INTO strategies (
            id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, added_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, s.name, s.author, s.lp_strategy,
          JSON.stringify(s.token_criteria), JSON.stringify(s.entry),
          JSON.stringify(s.range), JSON.stringify(s.exit),
          s.best_for, new Date().toISOString(), new Date().toISOString()
        );
      }
      db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('active_strategy', 'custom_ratio_spot');
    })();
    log("info", "strategy", "Preloaded default strategies into SQLite");
  }
}

ensureDefaultStrategies();

// ─── Tool Handlers ─────────────────────────────────────────────

function rowToStrategy(row) {
  if (!row) return null;
  return {
    ...row,
    token_criteria: JSON.parse(row.token_criteria || '{}'),
    entry: JSON.parse(row.entry || '{}'),
    range: JSON.parse(row.range || '{}'),
    exit: JSON.parse(row.exit || '{}'),
  };
}

/**
 * Add or update a strategy.
 * The agent parses the raw tweet/text and fills in the structured fields.
 */
export function addStrategy({
  id,
  name,
  author = "unknown",
  lp_strategy = "bid_ask",       // "bid_ask" | "spot" | "curve"
  token_criteria = {},           // { min_mcap, min_age_days, requires_kol, notes }
  entry = {},                    // { condition, price_change_threshold_pct, single_side }
  range = {},                    // { type, bins_below_pct, notes }
  exit = {},                     // { take_profit_pct, notes }
  best_for = "",                 // short description of ideal conditions
  raw = "",                      // original tweet/text
}) {
  if (!id || !name) return { error: "id and name are required" };

  const db = getDB();
  const slug = id.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO strategies (
      id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw, added_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug, name, author, lp_strategy,
    JSON.stringify(token_criteria), JSON.stringify(entry),
    JSON.stringify(range), JSON.stringify(exit),
    best_for, raw, now, now
  );

  // Auto-set as active if it's the first non-default strategy or if no active set
  const active = db.prepare("SELECT value FROM kv_store WHERE key = 'active_strategy'").get()?.value;
  if (!active) {
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run('active_strategy', slug);
  }

  log("info", "strategy", `Strategy saved to DB: ${name} (${slug})`);
  return { saved: true, id: slug, name, active: (active || slug) === slug };
}

/**
 * List all strategies with a summary.
 */
export function listStrategies() {
  const db = getDB();
  const active = db.prepare("SELECT value FROM kv_store WHERE key = 'active_strategy'").get()?.value;
  const rows = db.prepare('SELECT * FROM strategies').all();
  
  const strategies = rows.map((s) => ({
    id: s.id,
    name: s.name,
    author: s.author,
    lp_strategy: s.lp_strategy,
    best_for: s.best_for,
    active: active === s.id,
    added_at: s.added_at?.slice(0, 10),
  }));
  return { active, count: strategies.length, strategies };
}

/**
 * Get full details of a strategy including raw text and all criteria.
 */
export function getStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = getDB();
  const active = db.prepare("SELECT value FROM kv_store WHERE key = 'active_strategy'").get()?.value;
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  if (!row) {
    const available = db.prepare('SELECT id FROM strategies').all().map(r => r.id);
    return { error: `Strategy "${id}" not found`, available };
  }
  return { ...rowToStrategy(row), is_active: active === id };
}

/**
 * Set the active strategy used during screening cycles.
 */
export function setActiveStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = getDB();
  const row = db.prepare('SELECT name FROM strategies WHERE id = ?').get(id);
  if (!row) {
    const available = db.prepare('SELECT id FROM strategies').all().map(r => r.id);
    return { error: `Strategy "${id}" not found`, available };
  }
  
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run('active_strategy', id);
  log("info", "strategy", `Active strategy set in DB to: ${row.name}`);
  return { active: id, name: row.name };
}

/**
 * Remove a strategy.
 */
export function removeStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = getDB();
  const row = db.prepare('SELECT name FROM strategies WHERE id = ?').get(id);
  if (!row) return { error: `Strategy "${id}" not found` };
  
  db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
  
  const activeRow = db.prepare("SELECT value FROM kv_store WHERE key = 'active_strategy'").get();
  let newActive = activeRow?.value;
  if (activeRow?.value === id) {
    newActive = db.prepare('SELECT id FROM strategies LIMIT 1').get()?.id || null;
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run('active_strategy', newActive);
  }
  
  log("info", "strategy", `Strategy removed from DB: ${row.name}`);
  return { removed: true, id, name: row.name, new_active: newActive };
}

/**
 * Get the currently active strategy — used by screening cycle.
 */
export function getActiveStrategy() {
  const db = getDB();
  const activeId = db.prepare("SELECT value FROM kv_store WHERE key = 'active_strategy'").get()?.value;
  if (!activeId) return null;
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(activeId);
  return rowToStrategy(row);
}
