# kairos-dlmm-agent — Autonomous Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 5 improvement areas for fully autonomous DLMM operation — measurement, safety, PnL edge, cost/reliability, and ops hardening — without breaking existing functionality.

**Architecture:** Each section is self-contained and ships independently. Section 1 (measurement) is foundation; all later sections depend on its data.

**Tech Stack:** Node.js ≥20, ES modules, SQLite (better-sqlite3), Pino logging, OpenAI SDK.

**Key conventions (validated against codebase):**
- DB accessor: `getDB()` from `src/core/db.js` (capital B, not `getDb()`)
- New tables: via migration in `migrations/` at repo root, NOT `schema.js`
- `pool_deploys` PnL column: `pnl_pct` (not `pnl`)
- `performance` table does NOT store `minMcap` or `minTop10HolderRate` — use `organic_score`, `fee_tvl_ratio`, `volatility`, `bin_step`
- Timestamps: Unix ms stored; Asia/Jakarta formatted for display
- Telegram exports: `sendHTML`, `sendMessage`, `notifyDeploy`, `drainTelegramQueue`
- Health endpoint: `src/server/health.js`; use `_timersState` from `src/core/state/scheduler-state.js`
- GMGN delay: override to 2500ms constant
- Evolver MIN positions: 5; 4-hour cooldown already implemented

---

## Corrections Applied During Revalidation (2026-05-13)

| # | Issue Found | Correction |
|---|------------|-----------|
| 1 | Quality floor used `risk_score >= 30` (higher = MORE risky) | Changed to `risk_score <= 40 && confidence >= 40` (matches simulator pass gate) |
| 2 | Toxic memory threshold was 3+ deploys >66% loss rate | Tightened: **≥2 deploys with PnL < 0 = toxic** |
| 3 | `pool_deploys.pnl` — wrong column name | Corrected to `pool_deploys.pnl_pct` |
| 4 | MIN_EVOLVE_POSITIONS = 15 (too conservative) | Changed to 5 |
| 5 | GMGN delay from config was 350ms | Changed to **2500ms constant** for all GMGN hits |
| 6 | Safe mode blocks entire screener | Changed: safe mode blocks `deploy_position` tool only; screener continues; Telegram alert only on deactivation |
| 7 | Health endpoint has no Telegram alert | Added Telegram alert on new error type or stale screening (>1h) |
| 8 | Timestamps not timezone-specified | All timestamps in **Asia/Jakarta** |
| 9 | `getDb()` used (wrong) | Corrected to `getDB()` (capital B) |
| 10 | New tables via `schema.js`/`init.js` | Corrected to **migration 008** at repo root `migrations/` |
| 11 | `pnl_at_close` as finalize param (wrong) | Set via `updateCycleOutcome()` separately in management cycle |
| 12 | Task 6 duplicate table definition | Table already created in migration 008; Task 6 only inserts records |
| 13 | Task 7 queries `performance.minMcap` (doesn't exist) | Changed to use available columns: `organic_score`, `fee_tvl_ratio`, `volatility`, `bin_step` |

---

## File Map

| File | Responsibility |
|------|----------------|
| `migrations/008_cycle_outcomes.js` | Add all 3 tables: `cycle_outcomes`, `rejected_candidates`, `daily_snapshots` |
| `migrations/index.js` | Register migration 008 |
| `src/core/cycle-outcome.js` | New module: record and update cycle outcomes |
| `src/core/screening-cycle.js` | Hook measurement; add quality floor; add toxic memory fast-fail |
| `src/core/management-cycle.js` | Hook measurement; populate pnl_at_close on position close |
| `src/features/hive-mind.js` | Fix `lpAgentRelayEnabled` config path |
| `src/core/toxic-pool-filter.js` | New module: fast-fail toxic pools (≥2 losses = toxic) |
| `src/utils/lru-cache.js` | New module: LRU cache for recent rug pool tracking |
| `src/tools/executor.js` | Add per-base-mint exposure cap in safety checks |
| `src/core/phases.js` | Add `rangeMultiplier` per phase |
| `src/config.js` | Document conviction→rangeMultiplier mapping |
| `src/integrations/meteora/positions.js` | Add retry wrapper to getMyPositions |
| `src/core/lesson-service.js` | Extend with `analyzeFilterPerformance` method |
| `src/core/auto-filter-evolver.js` | New module: periodic filter evolution (MIN=5, GMGN 2500ms) |
| `src/utils/retry.js` | New module: retry wrapper + error taxonomy |
| `src/integrations/helius/index.js` | Add retry wrapper |
| `src/integrations/gmgn.js` | Apply GMGN 2500ms delay constant |
| `src/tools/agent-meridian.js` | Add retry wrapper |
| `src/core/safe-mode.js` | New module: safe mode blocks deploy tool only |
| `src/server/health.js` | Add last-cycle timestamps + Telegram alert on stale/error |
| `src/telegram/commands/safe-mode.js` | New Telegram/CLI handler for safe mode status/off |
| `src/core/daily-snapshot.js` | New module: capture daily snapshot (Jakarta timezone) |
| `package.json` | Fix CLI bin from `meridian` to `kairos` |

---

## Tasks

### Task 1: Measurement Layer — 3 tables + cycle hooks

**Files:**
- Create: `migrations/008_cycle_outcomes.js`
- Modify: `migrations/index.js`
- Create: `src/core/cycle-outcome.js`
- Modify: `src/core/screening-cycle.js`
- Modify: `src/core/management-cycle.js`

- [ ] **Step 1: Read existing migration pattern**

```bash
head -30 migrations/007_strategy_library.js
cat migrations/index.js
```

- [ ] **Step 2: Create migrations/008_cycle_outcomes.js**

```javascript
// NOTE: All 3 tables in one migration (cycle_outcomes, rejected_candidates, daily_snapshots)

export function migrate(db) {
  // cycle_outcomes
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      candidates_seen INTEGER DEFAULT 0,
      filters_passed INTEGER DEFAULT 0,
      llm_calls INTEGER DEFAULT 0,
      rpc_calls INTEGER DEFAULT 0,
      deploy_attempted INTEGER DEFAULT 0,
      deploy_confirmed INTEGER DEFAULT 0,
      deploy_position_id TEXT,
      pnl_at_close REAL,
      duration_ms INTEGER
    )
  `);

  // rejected_candidates
  db.exec(`
    CREATE TABLE IF NOT EXISTS rejected_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_timestamp INTEGER NOT NULL,
      pool_address TEXT NOT NULL,
      pool_name TEXT,
      simulator_score REAL,
      reason_rejected TEXT,
      llm_mentioned INTEGER DEFAULT 0,
      pnl_at_close REAL
    )
  `);

  // daily_snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL UNIQUE,
      total_positions INTEGER,
      open_positions INTEGER,
      realized_pnl_usd REAL,
      unrealized_pnl_usd REAL,
      sol_balance REAL,
      active_strategies TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_cycle_outcomes_type ON cycle_outcomes(cycle_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cycle_outcomes_timestamp ON cycle_outcomes(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rejected_candidates_pool ON rejected_candidates(pool_address)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rejected_candidates_cycle ON rejected_candidates(cycle_timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date)`);
}
```

- [ ] **Step 3: Register migration in migrations/index.js**

```javascript
import * as m008 from "./008_cycle_outcomes.js";

export const MIGRATIONS = [
  // ... existing { id: 1 } through { id: 7 } ...
  { id: 8, name: "cycle_outcomes_and_rejected_and_snapshots", fn: m008.migrate },
];
```

- [ ] **Step 4: Verify migration runs cleanly**

```bash
node -e "
import('/Users/nicholas_nanda/Documents/experimentalWorks/kairos-dlmm-agent/src/core/db.js').then(m => {
  const db = m.getDB();
  const cols = db.prepare('PRAGMA table_info(cycle_outcomes)').all().map(c => c.name);
  console.log('cycle_outcomes columns:', cols.join(', '));
  const missing = ['duration_ms', 'pnl_at_close', 'candidates_seen'].filter(c => !cols.includes(c));
  if (missing.length) throw new Error('missing: ' + missing.join(', '));
  const snap = db.prepare('PRAGMA table_info(daily_snapshots)').all().map(c => c.name);
  if (!snap.includes('snapshot_date')) throw new Error('daily_snapshots missing snapshot_date');
  console.log('PASS: migration 008 applied — all 3 tables verified');
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

- [ ] **Step 5: Create src/core/cycle-outcome.js**

```javascript
// NOTE: getDB (capital B), not getDb
import { getDB } from "../db.js";

export function startCycleOutcome(cycleType) {
  const db = getDB();
  const info = db.prepare(`
    INSERT INTO cycle_outcomes (cycle_type, timestamp) VALUES (?, ?)
  `).run(cycleType, Date.now());
  return info.lastInsertRowid;
}

export function updateCycleOutcome(id, patch) {
  const db = getDB();
  const ALLOWED = [
    "candidates_seen", "filters_passed", "llm_calls", "rpc_calls",
    "deploy_attempted", "deploy_confirmed", "deploy_position_id",
    "duration_ms", "pnl_at_close",
  ];
  const fields = Object.keys(patch).filter(k => ALLOWED.includes(k));
  if (fields.length === 0) return;
  const setClause = fields.map(f => `${f} = ?`).join(", ");
  const values = fields.map(f => patch[f]);
  db.prepare(`UPDATE cycle_outcomes SET ${setClause} WHERE id = ?`).run(...values, id);
}

export function finalizeCycleOutcome(id) {
  const db = getDB();
  const row = db.prepare("SELECT timestamp FROM cycle_outcomes WHERE id = ?").get(id);
  if (row) {
    db.prepare("UPDATE cycle_outcomes SET duration_ms = ? WHERE id = ?")
      .run(Date.now() - row.timestamp, id);
  }
}

export function recordDeployConfirmed(id, positionId) {
  updateCycleOutcome(id, { deploy_confirmed: 1, deploy_position_id: positionId });
}
```

- [ ] **Step 6: Hook into screening-cycle.js**

Add to imports:
```javascript
import { startCycleOutcome, updateCycleOutcome, finalizeCycleOutcome, recordDeployConfirmed } from "./cycle-outcome.js";
```

After pre-checks pass in `runScreeningCycle()`:
```javascript
const cycleId = startCycleOutcome("screening");
```

After candidates filtered, before LLM call:
```javascript
updateCycleOutcome(cycleId, {
  candidates_seen: candidates.length,
  filters_passed: passing.length,
  llm_calls: 1,
  rpc_calls: rpcCount,
});
```

After deploy confirmed:
```javascript
if (deployed) recordDeployConfirmed(cycleId, deployed.position);
finalizeCycleOutcome(cycleId);
```

- [ ] **Step 7: Hook into management-cycle.js**

Add to imports:
```javascript
import { startCycleOutcome, updateCycleOutcome, finalizeCycleOutcome } from "./cycle-outcome.js";
```

At top of `runManagementCycle()`:
```javascript
const cycleId = startCycleOutcome("management");
```

When position closes, set pnl_at_close:
```javascript
// In the close/profit-taking block:
updateCycleOutcome(cycleId, {
  pnl_at_close: position.pnl_pct ?? position.pnl_usd ?? null,
});
```

At end of function, after drain:
```javascript
finalizeCycleOutcome(cycleId);
```

- [ ] **Step 8: Commit**

```bash
git add migrations/008_cycle_outcomes.js migrations/index.js src/core/cycle-outcome.js src/core/screening-cycle.js src/core/management-cycle.js
git commit -m "feat: add cycle_outcomes, rejected_candidates, daily_snapshots tables and cycle hooks"
```

---

### Task 2: Safety — Fix hive-mind lpAgentRelayEnabled config path

**Files:**
- Modify: `src/features/hive-mind.js`

- [ ] **Step 1: Find the bad config path reference**

Search for `config.lpAgentRelayEnabled` in `src/features/hive-mind.js`. Change to `config.api?.lpAgentRelayEnabled ?? false`.

```javascript
// Before (line ~15):
const lpAgentRelayEnabled = config.lpAgentRelayEnabled;

// After:
const lpAgentRelayEnabled = config.api?.lpAgentRelayEnabled ?? false;
```

- [ ] **Step 2: Verify**

```bash
node -e "
import('../src/config.js').then(c => {
  const val = c.config.api?.lpAgentRelayEnabled;
  console.log('lpAgentRelayEnabled:', val);
  console.log(val !== undefined ? 'PASS: config path correct' : 'NOTE: not set in user-config.json yet (expected if never configured)');
});
"
```

- [ ] **Step 3: Commit**

```bash
git add src/features/hive-mind.js
git commit -m "fix: hive-mind reads lpAgentRelayEnabled from config.api path"
```

---

### Task 3: Safety — Toxic memory fast-fail (≥2 losses = toxic)

**Files:**
- Create: `migrations/008_cycle_outcomes.js` (already done in Task 1 — skip if already committed)
- Create: `src/core/toxic-pool-filter.js`
- Create: `src/utils/lru-cache.js`
- Modify: `src/core/screening-cycle.js`

- [ ] **Step 1: Create src/utils/lru-cache.js**

```javascript
export class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key) { return this.cache.has(key); }
  get(key) { return this.cache.get(key); }
  keys() { return this.cache.keys(); }
  clear() { this.cache.clear(); }
}
```

- [ ] **Step 2: Create src/core/toxic-pool-filter.js**

```javascript
import { getDB } from "../db.js";
import { LRUCache } from "../utils/lru-cache.js";

const recentRugCache = new LRUCache(200);

export function isToxicPool(poolAddress) {
  if (recentRugCache.has(poolAddress)) return true;

  const db = getDB();
  // NOTE: column is pnl_pct, not pnl
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

  // User's request: >= 2 losses = toxic (tightest gate, checked first)
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
```

- [ ] **Step 3: Wire into screening-cycle.js**

After `fetchAndReconCandidates` returns and before simulator runs:
```javascript
import { isToxicPool, markPoolAsRug } from "./toxic-pool-filter.js";

const nonToxicCandidates = candidates.filter(c => {
  if (isToxicPool(c.pool_address)) {
    log("debug", "screening", `Pool ${c.pool_address} blocked — toxic memory`);
    return false;
  }
  return true;
});
```

Also after deploy attempt — if tx reverts, call `markPoolAsRug(poolAddress)`.

- [ ] **Step 4: Write unit test**

```javascript
// tests/unit/toxic-pool-filter.test.js
import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { isToxicPool, markPoolAsRug } from "../../src/core/toxic-pool-filter.js";

const emptyDb = () => ({ prepare: () => ({ all: () => [] }) });

describe("isToxicPool", () => {
  it("returns false for pool with no history", () => {
    mock.module("../../src/core/db.js", { namedExports: { getDB: emptyDb } });
    assert.strictEqual(isToxicPool("NewPool"), false);
  });

  it("blocks pool with >= 2 losses", () => {
    mock.module("../../src/core/db.js", {
      namedExports: { getDB: () => ({
        prepare: () => ({ all: () => [
          { pnl_pct: -0.3 },
          { pnl_pct: -0.1 },
        ])}),
      }) },
    );
    assert.strictEqual(isToxicPool("TwoLosses"), true);
  });

  it("blocks pool with PnL < -90%", () => {
    mock.module("../../src/core/db.js", {
      namedExports: { getDB: () => ({
        prepare: () => ({ all: () => [{ pnl_pct: -0.95 }] }),
      }) },
    );
    assert.strictEqual(isToxicPool("Rugged"), true);
  });

  it("allows pool with 1 loss and 1 gain", () => {
    mock.module("../../src/core/db.js", {
      namedExports: { getDB: () => ({
        prepare: () => ({ all: () => [
          { pnl_pct: -0.3 },
          { pnl_pct: 0.5 },
        ])}),
      }) },
    );
    assert.strictEqual(isToxicPool("MixedBag"), false);
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/lru-cache.js src/core/toxic-pool-filter.js src/core/screening-cycle.js tests/unit/toxic-pool-filter.test.js
git commit -m "feat: add toxic pool fast-fail with >=2 losses = toxic gate"
```

---

### Task 4: Safety — Quality floor + per-base-mint exposure cap

**Files:**
- Modify: `src/core/screening-cycle.js` (quality floor)
- Modify: `src/tools/executor.js` (exposure cap)

- [ ] **Step 1: Add quality floor in screening-cycle.js**

After `simulations` are computed and before building candidate blocks:
```javascript
const MIN_RISK_SCORE = 40;  // NOTE: lower = safer; 0 = no risk; simulator adds up risk factors
const MIN_CONFIDENCE = 40;

const qualityCandidates = passing.map((c, i) => ({ ...c, simulation: simulations[i] }))
  .filter(c => (c.simulation?.risk_score ?? 100) <= MIN_RISK_SCORE
             && (c.simulation?.confidence ?? 0) >= MIN_CONFIDENCE);

if (qualityCandidates.length === 0) {
  log("info", "screening", `No candidates met quality floor (risk_score<=${MIN_RISK_SCORE}, confidence>=${MIN_CONFIDENCE})`);
  finalizeCycleOutcome(cycleId);
  if (!silent && telegramEnabled()) {
    sendHTML(`<b>🔍 Screening Cycle</b>\n\nNo candidates met minimum quality thresholds. Screening skipped.`);
  }
  return null;
}
```

Update `buildCandidateBlocks` to use `qualityCandidates` instead of `passing`.

- [ ] **Step 2: Add per-base-mint exposure cap in executor.js**

In `runSafetyChecks()`, after the duplicate pool check:
```javascript
const MAX_POSITIONS_PER_BASE_MINT = 3;
const existingPositions = positions?.positions || [];
const baseMintCounts = {};
for (const pos of existingPositions) {
  const mint = (pos.base_mint || "").toLowerCase();
  baseMintCounts[mint] = (baseMintCounts[mint] || 0) + 1;
}
const mint = (params.base_mint || "").toLowerCase();
if (mint && (baseMintCounts[mint] || 0) >= MAX_POSITIONS_PER_BASE_MINT) {
  return {
    blocked: true,
    reason: `exposure_cap: base mint ${mint} already has ${baseMintCounts[mint]} positions (max ${MAX_POSITIONS_PER_BASE_MINT})`,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/core/screening-cycle.js src/tools/executor.js
git commit -m "feat: add candidate quality floor and per-base-mint exposure cap"
```

---

### Task 5: PnL Edge — Phase-specific range multiplier

**Files:**
- Modify: `src/core/phases.js`
- Modify: `src/core/screening-cycle.js`

- [ ] **Step 1: Add rangeMultiplier to PHASE_CONFIG in phases.js**

```javascript
export const PHASE_CONFIG = {
  TRENDING_UP:    { rangeMultiplier: 1.5, label: "Trending Up" },
  TRENDING_DOWN:  { rangeMultiplier: 1.0, label: "Trending Down" },
  RANGE_BOUND:    { rangeMultiplier: 1.2, label: "Range Bound" },
  VOLATILE:       { rangeMultiplier: 0.8, label: "Volatile" },
  LIQUIDITY_GRAB: { rangeMultiplier: 0.5, label: "Liquidity Grab" },
  NEUTRAL:        { rangeMultiplier: 1.0, label: "Neutral" },
};
```

- [ ] **Step 2: Apply rangeMultiplier in screening-cycle after LLM picks candidate**

```javascript
const phaseMultiplier = PHASE_CONFIG[phase]?.rangeMultiplier ?? 1.0;
const baseBinsAbove = activeStrategy?.range?.bins_above ?? config.strategy.binsAbove;
const adjustedBinsAbove = Math.round(baseBinsAbove * phaseMultiplier);
```

Add `phaseAdjustedRange` to the system prompt so LLM knows adjusted range is being applied.

- [ ] **Step 3: Commit**

```bash
git add src/core/phases.js src/core/screening-cycle.js
git commit -m "feat: add phase-specific range multiplier for bin placement"
```

---

### Task 6: PnL Edge — Rejection audit trail

**Files:**
- Modify: `src/core/screening-cycle.js` (insert records — table already created in migration 008)

- [ ] **Step 1: Insert rejected candidates after LLM decision**

After LLM returns a decision in screening-cycle.js:
```javascript
import { getDB } from "../db.js";

const db = getDB();
const cycleTimestamp = Date.now();
const deployedPoolAddr = deployed?.pool_address || null;

const insertStmt = db.prepare(`
  INSERT INTO rejected_candidates (cycle_timestamp, pool_address, pool_name, simulator_score, reason_rejected, llm_mentioned)
  VALUES (?, ?, ?, ?, ?, ?)
`);

for (const c of qualityCandidates) {
  const wasSelected = c.pool_address === deployedPoolAddr;
  insertStmt.run(
    cycleTimestamp,
    c.pool_address,
    c.pool_name || c.token_symbol || "unknown",
    c.simulation?.risk_score ?? null,
    wasSelected ? "selected" : "not_selected",
    wasSelected ? 1 : 0
  );
}
```

Also backfill `pnl_at_close` when that candidate's position closes — in management-cycle close block:
```javascript
const rejectedPool = db.prepare(
  "UPDATE rejected_candidates SET pnl_at_close = ? WHERE pool_address = ? AND pnl_at_close IS NULL"
).run(position.pnl_pct ?? null, position.pool);
```

- [ ] **Step 2: Commit**

```bash
git add src/core/screening-cycle.js src/core/management-cycle.js
git commit -m "feat: record rejected candidates with simulator scores for audit trail"
```

---

### Task 7: PnL Edge — Auto filter evolution (MIN=5, GMGN 2500ms)

**Files:**
- Create: `src/core/auto-filter-evolver.js`
- Modify: `src/index.js`
- Modify: `src/integrations/gmgn.js`

- [ ] **Step 1: Create src/core/auto-filter-evolver.js**

**NOTE:** `performance` table does NOT have `minMcap` or `minTop10HolderRate` columns. Use available columns: `organic_score`, `fee_tvl_ratio`, `volatility`, `bin_step`.

```javascript
import { getDB } from "../db.js";
import { loadUserConfig, saveUserConfig } from "../config.js";
import { log } from "./logger.js";
import crypto from "crypto";
import fs from "fs";
import writeFileAtomic from "write-file-atomic";
import { USER_CONFIG_PATH } from "../config.js";

const EVOLVE_MIN_POSITIONS = 5;  // was 15 — faster adaptation for autonomous ops
const SANITY_BAND = 0.30;        // ±30% of current value

// Signal columns available in performance table (validated against migrations/001_initial_schema.js):
// organic_score, fee_tvl_ratio, volatility, bin_step
// NOT available: minMcap, minTop10HolderRate
const SIGNAL_COLUMNS = ["organic_score", "fee_tvl_ratio", "volatility", "bin_step"];

export function analyzeFilterPerformance() {
  const db = getDB();
  const positions = db.prepare(`
    SELECT position, pnl_pct, organic_score, fee_tvl_ratio, volatility, bin_step
    FROM performance
    WHERE pnl_pct IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT 100
  `).all();

  if (positions.length < EVOLVE_MIN_POSITIONS) {
    log("debug", "evolver", `${positions.length} < ${EVOLVE_MIN_POSITIONS} — skipping`);
    return null;
  }

  const medianPnl = [...positions].sort((a, b) => a.pnl_pct - b.pnl_pct)[Math.floor(positions.length / 2)].pnl_pct;
  const winners = positions.filter(p => p.pnl_pct > medianPnl);
  const losers  = positions.filter(p => p.pnl_pct < medianPnl);

  if (winners.length < 2 || losers.length < 2) return null;

  const config = loadUserConfig();
  const changes = [];

  for (const col of SIGNAL_COLUMNS) {
    const current = config.screening?.[col];
    if (current == null) continue;

    const winnerVals = winners.map(p => p[col]).filter(v => v != null);
    const loserVals  = losers.map(p => p[col]).filter(v => v != null);
    if (winnerVals.length === 0 || loserVals.length === 0) continue;

    const winnerAvg = winnerVals.reduce((s, v) => s + v, 0) / winnerVals.length;
    const loserAvg  = loserVals.reduce((s, v) => s + v, 0) / loserVals.length;

    // For organic_score and fee_tvl_ratio: higher = better → if losers are lower, tighten
    // For volatility and bin_step: specific direction matters
    const direction = (col === "organic_score" || col === "fee_tvl_ratio") ? "higher_better" : "neutral";

    let proposed;
    if (direction === "higher_better" && loserAvg < winnerAvg * 0.8) {
      const target = winnerAvg * 0.9;
      proposed = clamp(target, current * (1 - SANITY_BAND), current * (1 + SANITY_BAND));
    } else {
      continue;
    }

    if (Math.abs(proposed - current) < current * 0.05) continue;
    const rounded = typeof current === "number" && current < 1 ? Number(proposed.toFixed(4)) : Math.round(proposed);
    changes.push({ filter: col, current, proposed: rounded, winnerAvg, loserAvg });
  }

  if (changes.length === 0) return null;

  // Persist to user-config.json
  for (const { filter, proposed } of changes) {
    if (!config.screening) config.screening = {};
    config.screening[filter] = proposed;
  }
  config._lastFilterEvolution = new Date().toISOString();
  writeFileAtomic.sync(USER_CONFIG_PATH, JSON.stringify(config, null, 2));

  // Log to lessons
  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    `[AUTO-EVOLVED filters] ${changes.map(c => `${c.filter}: ${c.current} → ${c.proposed}`).join(", ")}`,
    JSON.stringify(["evolution", "filter_evolution"]),
    "evolution",
    new Date().toISOString()
  );

  return changes;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
```

- [ ] **Step 2: Wire trigger into src/index.js**

```javascript
import { analyzeFilterPerformance } from "./core/auto-filter-evolver.js";

// After the existing lesson-service evolution trigger:
const filterChanges = analyzeFilterPerformance();
if (filterChanges?.length > 0) {
  log("info", "evolver", `Auto-evolved ${filterChanges.length} filter parameters`);
}
```

- [ ] **Step 3: Override GMGN delay to 2500ms in src/integrations/gmgn.js**

Find the `paceGmgnRequest()` function. Change the delay constant:
```javascript
const GMGN_DELAY_MS = 2500;  // user request: 2500ms between GMGN requests

async function paceGmgnRequest() {
  const delayMs = GMGN_DELAY_MS;  // override config; always 2500ms
  const elapsed = Date.now() - _lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  _lastGmgnRequestAt = Date.now();
}
```

- [ ] **Step 4: Commit**

```bash
git add src/core/auto-filter-evolver.js src/index.js src/integrations/gmgn.js
git commit -m "feat: add auto filter evolution (MIN=5) and GMGN 2500ms delay"
```

---

### Task 8: Ops Hardening — Safe mode (block deploy tool only) + health Telegram alert

**Files:**
- Create: `src/core/safe-mode.js`
- Create: `src/telegram/commands/safe-mode.js`
- Modify: `src/server/health.js`
- Modify: `src/tools/executor.js` (block deploy in safe mode)
- Modify: `src/core/screening-cycle.js` (trigger safe mode on hallucination)
- Modify: `src/core/management-cycle.js`

- [ ] **Step 1: Create src/core/safe-mode.js**

```javascript
import { loadUserConfig, saveUserConfig } from "../config.js";
import { log } from "./logger.js";
import { sendHTML } from "../notifications/telegram.js";
import { captureAlert } from "../instrument.js";

const HALLUCINATION_THRESHOLD = 3;
const CONSECUTIVE_FAIL_THRESHOLD = 3;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const _hallucinationHistory = [];
const _consecutiveFailHistory = [];
let _active = null; // null = unknown, read from config on first use

function isActive() {
  if (_active !== null) return _active;
  _active = loadUserConfig().safety?.safeModeActive === true;
  return _active;
}

export function recordHallucination() {
  const now = Date.now();
  _hallucinationHistory.push(now);
  const recent = _hallucinationHistory.filter(t => now - t < WINDOW_MS);
  recent.length = Math.min(recent.length, HALLUCINATION_THRESHOLD);
  if (recent.length >= HALLUCINATION_THRESHOLD) {
    activate("hallucination_spike");
  }
}

export function recordDeployFailure() {
  const now = Date.now();
  _consecutiveFailHistory.push(now);
  const recent = _consecutiveFailHistory.filter(t => now - t < WINDOW_MS);
  recent.length = Math.min(recent.length, CONSECUTIVE_FAIL_THRESHOLD);
  if (recent.length >= CONSECUTIVE_FAIL_THRESHOLD) {
    activate("consecutive_deploy_failures");
  }
}

export function isSafeModeActive() {
  return isActive();
}

export function activate(reason) {
  if (isActive()) return;
  _active = true;
  const config = loadUserConfig();
  config.safety = config.safety || {};
  config.safety.safeModeActive = true;
  config.safety.safeModeReason = reason;
  config.safety.safeModeSince = Date.now();
  saveUserConfig(config);
  captureAlert(`SAFE MODE ACTIVATED: ${reason}. Deploys disabled.`);
  log("warn", "safe-mode", `SAFE MODE ACTIVATED: ${reason}`);
}

export function deactivate() {
  if (!isActive()) return;
  _active = false;
  const config = loadUserConfig();
  config.safety = config.safety || {};
  config.safety.safeModeActive = false;
  saveUserConfig(config);
  log("info", "safe-mode", "SAFE MODE DEACTIVATED by manual reset");
  sendHTML("<b>✅ Safe Mode Deactivated</b>\nDeploys re-enabled.").catch(() => {});
}
```

- [ ] **Step 2: Wire deploy tool block in executor.js**

In `runSafetyChecks()` for `deploy_position`:
```javascript
import { isSafeModeActive } from "../core/safe-mode.js";

if (isSafeModeActive()) {
  return { blocked: true, reason: "safe_mode_active" };
}
```

Also after deploy failure (tx revert, etc.), call `recordDeployFailure()`.

- [ ] **Step 3: Trigger safe mode on hallucination in screening-cycle.js**

After the hallucination `captureAlert()` call:
```javascript
import { recordHallucination } from "./safe-mode.js";
recordHallucination();
```

- [ ] **Step 4: Enrich health endpoint in src/server/health.js**

```javascript
import { _timersState } from "./state/scheduler-state.js";

export function getHealth() {
  const now = Date.now();
  const stale = _timersState.screeningLastTriggered
    ? now - _timersState.screeningLastTriggered > 3600_000  // >1h
    : true;

  return {
    ok: true,
    uptime: process.uptime(),
    last_successful_screening_ts: _timersState.screeningLastTriggered ?? null,
    last_successful_management_ts: _timersState.pollTriggeredAt ?? null,
    last_error_type: _timersState.lastErrorType ?? null,
    last_error_ts: _timersState.lastErrorTs ?? null,
    safe_mode_active: isSafeModeActive(),
  };
}
```

Also add Telegram alert on stale screening (>1h) — add to the cron/scheduler where `screeningLastTriggered` is updated:
```javascript
import { sendHTML } from "../notifications/telegram.js";

if (now - _timersState.screeningLastTriggered > 3600_000) {
  sendHTML(`⚠️ Screening stale: last run ${Math.round((now - _timersState.screeningLastTriggered) / 60000)} min ago`).catch(() => {});
}
```

- [ ] **Step 5: Create Telegram/CLI handler src/telegram/commands/safe-mode.js**

```javascript
import { isSafeModeActive, activate, deactivate } from "../../core/safe-mode.js";
import { loadUserConfig } from "../../config.js";
import { sendHTML } from "../../notifications/telegram.js";

export async function handleSafeModeCommand(args, replyFn) {
  if (args[0] === "status") {
    const active = isSafeModeActive();
    const reason = loadUserConfig().safety?.safeModeReason;
    const since = loadUserConfig().safety?.safeModeSince;
    const sinceStr = since ? new Date(since).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : null;
    const msg = `Safe mode: ${active ? "ACTIVE" : "OFF"}\n${active && reason ? `Reason: ${reason}${sinceStr ? `\nSince: ${sinceStr}` : ""}` : ""}`;
    return replyFn(msg);
  }
  if (args[0] === "off" || args[0] === "disable") {
    deactivate();
    return replyFn("Safe mode deactivated. Deploys re-enabled.");
  }
  return replyFn("Usage: /safe-mode [status|off]");
}
```

- [ ] **Step 6: Commit**

```bash
git add src/core/safe-mode.js src/telegram/commands/safe-mode.js src/server/health.js src/tools/executor.js src/core/screening-cycle.js src/core/management-cycle.js
git commit -m "feat: add safe mode (block deploy tool only) with Telegram alert on stale/deactivation"
```

---

### Task 9: Cost + Reliability — Retry + error taxonomy

**Files:**
- Create: `src/utils/retry.js`
- Modify: `src/integrations/helius/index.js`
- Modify: `src/integrations/meteora/positions.js`
- Modify: `src/tools/agent-meridian.js`

- [ ] **Step 1: Create src/utils/retry.js**

```javascript
export class RetryError extends Error {
  constructor(message, cause, retries) {
    super(message);
    this.name = "RetryError";
    this.cause = cause;
    this.retries = retries;
  }
}

export const ErrorType = {
  NETWORK: "NETWORK",
  RATE_LIMIT: "RATE_LIMIT",
  VALIDATION: "VALIDATION",
  UNKNOWN: "UNKNOWN",
};

export function classifyError(err) {
  const msg = err?.message || "";
  const status = err?.status || err?.statusCode || 0;
  if (status === 429 || msg.toLowerCase().includes("rate limit")) return ErrorType.RATE_LIMIT;
  if (status >= 500 || /socket|timeout|network|econnreset|ECONNREFUSED/i.test(msg)) return ErrorType.NETWORK;
  if (status === 400 || status === 422 || /invalid|validation/i.test(msg)) return ErrorType.VALIDATION;
  return ErrorType.UNKNOWN;
}

export async function withRetry(fn, {
  maxRetries = 3,
  initialDelayMs = 1000,
  maxDelayMs = 10000,
  shouldRetry = (e) => classifyError(e) !== ErrorType.VALIDATION,
} = {}) {
  let lastError;
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !shouldRetry(err)) {
        throw new RetryError(`Failed after ${attempt} retries: ${err.message}`, err, attempt);
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  throw lastError;
}
```

- [ ] **Step 2: Wrap getMyPositions in src/integrations/meteora/positions.js**

Read the current `getMyPositions` function. Wrap the RPC/cache logic:
```javascript
import { withRetry, classifyError, ErrorType } from "../../utils/retry.js";

export async function getMyPositions({ force = false, silent = false } = {}) {
  return withRetry(async (attempt) => {
    // existing logic here
  }, {
    maxRetries: 3,
    initialDelayMs: 2000,
    shouldRetry: (e) => classifyError(e) !== ErrorType.VALIDATION,
  });
}
```

- [ ] **Step 3: Wrap getWalletBalances in src/integrations/helius/index.js**

```javascript
import { withRetry, classifyError } from "../../utils/retry.js";

export async function getWalletBalances(wallet) {
  return withRetry(async () => {
    // existing logic
  }, { maxRetries: 3, initialDelayMs: 2000 });
}
```

- [ ] **Step 4: Wrap relay calls in src/tools/agent-meridian.js**

```javascript
import { withRetry, classifyError } from "../utils/retry.js";
```

- [ ] **Step 5: Write test**

```javascript
// tests/unit/retry.test.js
import { withRetry, classifyError, ErrorType } from "../../src/utils/retry.js";
import { describe, it } from "node:test";
import assert from "node:assert";

describe("classifyError", () => {
  it("classifies rate limit", () => {
    assert.strictEqual(classifyError({ status: 429 }), ErrorType.RATE_LIMIT);
  });
  it("classifies network errors", () => {
    assert.strictEqual(classifyError({ status: 500 }), ErrorType.NETWORK);
    assert.strictEqual(classifyError({ message: "socket hang up" }), ErrorType.NETWORK);
  });
  it("classifies validation errors", () => {
    assert.strictEqual(classifyError({ status: 400 }), ErrorType.VALIDATION);
  });
});

describe("withRetry", () => {
  it("returns on success", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    assert.strictEqual(result, 42);
  });
  it("throws after max retries", async () => {
    let attempts = 0;
    try {
      await withRetry(() => { attempts++; throw new Error("fail"); }, { maxRetries: 2, initialDelayMs: 10 });
      assert.fail("should throw");
    } catch (e) {
      assert.strictEqual(e.retries, 2);
      assert.strictEqual(attempts, 3);
    }
  });
  it("no retry on validation errors", async () => {
    let attempts = 0;
    try {
      await withRetry(() => { attempts++; throw { status: 400 }; }, { maxRetries: 2, initialDelayMs: 10 });
      assert.fail("should throw");
    } catch (e) {
      assert.strictEqual(attempts, 1);
    }
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/retry.js src/integrations/helius/index.js src/integrations/meteora/positions.js src/tools/agent-meridian.js tests/unit/retry.test.js
git commit -m "feat: standardize retries and error taxonomy across integrations"
```

---

### Task 10: Ops Hardening — CLI bin name fix

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Fix bin name**

```json
"bin": {
  "kairos": "src/cli.js"
}
```

Also check `src/cli.js` shebang — no changes needed unless it references `meridian`.

- [ ] **Step 2: Verify**

```bash
node -e "
import('/Users/nicholas_nanda/Documents/experimentalWorks/kairos-dlmm-agent/package.json', { assert: { type: 'json' } }).then(p => {
  const name = Object.keys(p.default.bin || {})[0];
  if (name !== 'kairos') throw new Error('expected kairos, got: ' + name);
  console.log('PASS: CLI bin is kairos');
}).catch(e => { console.error(e.message); process.exit(1); });
"
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "fix: rename CLI bin from meridian to kairos"
```

---

### Task 11: Ops Hardening — Daily performance snapshot (Jakarta timezone)

**Files:**
- Create: `src/core/daily-snapshot.js`
- Modify: `src/index.js`

- [ ] **Step 1: Create src/core/daily-snapshot.js**

```javascript
import { getDB } from "../db.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { log } from "./logger.js";

const TZ = "Asia/Jakarta";

export function toJakartaDate() {
  return new Date().toLocaleString("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .replace(/\//g, "-");  // "YYYY-MM-DD"
}

export function jakartaTimestamp() {
  return new Date().toLocaleString("en-CA", { timeZone: TZ }).replace(",", "");
}

export async function captureDailySnapshot() {
  const db = getDB();
  const today = toJakartaDate();

  const existing = db.prepare("SELECT id FROM daily_snapshots WHERE snapshot_date = ?").get(today);
  if (existing) {
    log("debug", "snapshot", `Daily snapshot for ${today} already exists`);
    return;
  }

  const [positions, balance] = await Promise.all([
    getMyPositions({ force: true }).catch(() => null),
    getWalletBalances().catch(() => null),
  ]);

  const open = (positions?.positions || []).filter(p => !p.closed);
  const realized = positions?.total_pnl_realized ?? 0;
  const unrealized = open.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);

  db.prepare(`
    INSERT INTO daily_snapshots (snapshot_date, total_positions, open_positions, realized_pnl_usd, unrealized_pnl_usd, sol_balance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    today,
    (positions?.positions || []).length,
    open.length,
    realized,
    unrealized,
    balance?.sol ?? 0,
    Date.now()
  );

  log("info", "snapshot", `Daily snapshot ${today}: ${open.length} open, realized $${realized.toFixed(2)}, unrealized $${unrealized.toFixed(2)}, SOL ${balance?.sol ?? 0}`);
}
```

- [ ] **Step 2: Wire into src/index.js cron**

```javascript
import { captureDailySnapshot } from "./core/daily-snapshot.js";
// Add cron entry: 0 0 * * * (midnight Jakarta time)
schedule("0 0 * * *", async () => {
  await captureDailySnapshot();
}, { name: "daily-snapshot" });
```

- [ ] **Step 3: Commit**

```bash
git add src/core/daily-snapshot.js src/index.js
git commit -m "feat: add daily performance snapshot in Asia/Jakarta timezone"
```

---

## Implementation Order

1. **Task 1** — 3 tables + cycle hooks (foundation)
2. **Task 2** — config fix (1 file, quick win)
3. **Task 3** — toxic memory fast-fail (safety impact)
4. **Task 4** — quality floor + exposure cap (safety impact)
5. **Task 5** — phase range multiplier (PnL impact)
6. **Task 6** — rejection audit trail (depends on Task 1)
7. **Task 7** — auto filter evolution + GMGN 2500ms (depends on Task 1)
8. **Task 9** — retry + error taxonomy (independent)
9. **Task 10** — CLI bin fix (1 file, quick win)
10. **Task 8** — safe mode + health Telegram (independent, critical safety)
11. **Task 11** — daily snapshot (independent)

---

## Self-Review Checklist

- [ ] All 11 tasks present, no gaps, no duplicate numbers.
- [ ] `getDB()` used throughout (not `getDb()`).
- [ ] All 3 tables created in migration 008 (not schema.js).
- [ ] `pool_deploys.pnl_pct` used (not `pnl`).
- [ ] `performance` columns: `organic_score`, `fee_tvl_ratio`, `volatility`, `bin_step` only.
- [ ] Quality floor: `risk_score <= 40 && confidence >= 40`.
- [ ] Toxic memory: `losses.length >= 2` first gate.
- [ ] Safe mode: blocks deploy tool only, screener continues.
- [ ] GMGN delay: 2500ms constant override.
- [ ] Evolver MIN positions: 5.
- [ ] Timestamps: Unix ms stored, Asia/Jakarta formatted.
- [ ] Telegram: `sendHTML`, `notifyDeploy`, `drainTelegramQueue` (no made-up exports).
- [ ] Health: uses `_timersState` from `src/core/state/scheduler-state.js`.
- [ ] All corrections from revalidation table applied.

---

## Execution Options

**Plan complete and saved to `docs/superpowers/plans/2026-05-12-kairos-autonomous-plan.md`.**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
