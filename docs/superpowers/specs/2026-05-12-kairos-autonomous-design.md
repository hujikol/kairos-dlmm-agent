# kairos-dlmm-agent — Autonomous Operation Design

**Date:** 2026-05-12
**Revised:** 2026-05-13
**Author:** Senior JS Dev + DLMM Deployer Review
**Status:** Draft (pending user approval)

---

## Context

Kairos is a fully autonomous DLMM LP agent for Meteora pools on Solana (forked from Meridian). The goal is to make it safer, more measurable, more profitable, and cheaper to operate — without breaking existing functionality.

**Known issues addressed in design:**
- Memory leaks (telegram recursive drain, cache eviction, registry Map overrides) — fixed in past commits
- Broken deploys (safety check typos, DRY_RUN env leaking) — fixed in past commits
- Persistent LLM deploy hallucination in screening cycle — minimized via on-chain diff verification

---

## Sections

### Section 1 — Measurement Layer

**Goal:** Every cycle must produce a structured outcome record so every change has a before/after number.

**Schema — `cycle_outcomes` table:**
```
id           INTEGER PRIMARY KEY AUTOINCREMENT
cycle_type   TEXT NOT NULL        -- "screening" | "management"
timestamp    INTEGER NOT NULL     -- Unix ms (UTC)
candidates_seen  INTEGER
filters_passed   INTEGER
llm_calls        INTEGER
rpc_calls        INTEGER
deploy_attempted INTEGER          -- 0 | 1
deploy_confirmed INTEGER          -- 0 | 1
deploy_position_id TEXT
pnl_at_close     REAL             -- populated when position closes (pct or USD)
duration_ms      INTEGER
```

**Schema — `rejected_candidates` table:**
```
id INTEGER PRIMARY KEY AUTOINCREMENT
cycle_timestamp INTEGER NOT NULL   -- Unix ms, matches cycle_outcomes.timestamp
pool_address TEXT NOT NULL
pool_name TEXT
simulator_score REAL
reason_rejected TEXT
llm_mentioned INTEGER DEFAULT 0   -- 1 if selected by LLM
pnl_at_close REAL                -- populated when that candidate's position closes
```

**Schema — `daily_snapshots` table:**
```
id INTEGER PRIMARY KEY AUTOINCREMENT
snapshot_date TEXT NOT NULL UNIQUE  -- "YYYY-MM-DD" in Asia/Jakarta timezone
total_positions INTEGER
open_positions INTEGER
realized_pnl_usd REAL
unrealized_pnl_usd REAL
sol_balance REAL
active_strategies TEXT
created_at INTEGER NOT NULL       -- Unix ms
```

**Implementation:**
- All 3 tables added via migration (migrations/ at repo root), not schema.js.
- `cycle_outcomes` hooked into `runScreeningCycle()` and `runManagementCycle()` — write record at start, update on complete/fail.
- `pnl_at_close` populated by management cycle when position closes via `updateCycleOutcome()`.
- `rejected_candidates` written after LLM decision — every candidate that passed filters gets a row.
- `daily_snapshots` captured at midnight Jakarta time.
- No cost tracking (user opted out of llm_cost_usd).

**Why first:** Every other section (safety, PnL, cost) needs this data to measure impact.

---

### Section 2 — Autonomous Safety Upgrades

**Goal:** Tighten guardrails before the LLM gets a say, so catastrophic losses are structurally impossible even if the LLM behaves unexpectedly.

#### 2a) Candidate quality floor before LLM call

In `runScreeningCycle()`, check simulator outputs (`risk_score`, `confidence`) before calling the LLM. **Note:** In simulator.js, `risk_score` starts at 0 and INCREASES as risk factors accumulate — higher = MORE risky. The simulator's pass gate is `risk_score <= 40 && confidence >= 40`.

Quality floor threshold: `risk_score <= 40 && confidence >= 40` (same as simulator pass gate, to keep it consistent).

If no candidate passes, skip LLM entirely and log a deterministic "no candidates met quality floor" report. Eliminates LLM calls with no good option, reduces hallucination surface.

#### 2b) Fast-fail toxic memory (no LLM needed)

Read from `pool_deploys` (joined with pool_memory) at screening time. Block pool if ANY of these conditions are met:

| Condition | Action |
|-----------|--------|
| **≥2 deploys with PnL < 0** | Block (user request — tightest gate) |
| ≥3 deploys AND loss rate >66% | Block (existing rule) |
| ≥2 deploys AND avg PnL < −70% | Block |
| Any single deploy with PnL < −90% | Block (catches liquidity grab / rug immediately) |

Also maintain an in-memory LRU cache ("recent rug" cache, 30-minute TTL) that records pools where a deploy tx reverted — no LLM needed.

**DB note:** `pool_deploys` column is `pnl_pct` (from migrations/001_initial_schema.js), NOT `pnl`.

#### 2c) Per-base-mint exposure cap

In `runSafetyChecks()` in `src/tools/executor.js`, add: if the base token of the candidate pool already has ≥3 open positions across the wallet, block the deploy. Prevents over-concentration in a single token.

#### 2d) Fix config path mismatch for hive-mind relay

In `src/features/hive-mind.js`, the code references `config.lpAgentRelayEnabled`. The actual config key is `config.api.lpAgentRelayEnabled` (nested under `api`).

---

### Section 3 — PnL Edge

**Goal:** Push more bin math out of the LLM and into deterministic code; give the agent a self-tuning filter evolution mechanism.

#### 3a) LLM picks pool + conviction; code calculates range

Split the responsibility:
- **LLM role:** Pick which pool and state conviction level (very_high / high / normal / low).
- **Code role:** Take conviction → apply correct strategy config + compute actual bin placement based on current price, volatility, and active bin.

The LLM prompt becomes: "Here are N candidates ranked by simulator. Pick one and state conviction." The rest is computed deterministically.

Risk: If filter gates are misconfigured, every deploy follows the same bad pattern. Mitigation: The evolution system in `lesson-service.js` adjusts config over time from outcomes. Deterministic layer inherits from that evolution loop.

#### 3b) Phase-specific range override in code

Detect phase in code (via `phases.js`) and apply a phase-specific `rangeMultiplier`:
- `LIQUIDITY_GRAB` → 0.5× (tighter range to avoid being swept)
- `TRENDING_UP` → 1.5× (wider range to capture momentum)
- `NEUTRAL` / other phases → 1.0×

Instead of relying on LLM to infer phase behavior, enforce it in code.

#### 3c) Rejection audit trail

Every screening cycle, record for every candidate that passed filters:
- `pool_address`, `pool_name`, `simulator_score`, `llm_mentioned`, `reason_rejected`

Stored in `rejected_candidates` table. When that pool's position eventually closes, backfill `pnl_at_close`.

This feeds filter tuning — if 3 candidates with score >60 keep getting rejected for the same reason, either adjust the filter or fix the strategy.

#### 3d) Auto filter evolution

After every 5 closed positions (MIN_EVOLVE_POSITIONS = 5, user request — faster adaptation than the previous 15), run a lightweight analyze pass:
1. Read `performance` table — identify which filter params correlated with winners/losers.
2. Propose mutations to `user-config.json` (e.g., `{ filter: "minOrganic", current: 60, proposed: 65, reason: "winners avg 68 organic, losers avg 41" }`).
3. Apply only if mutation passes sanity check (new value within ±30% of current — prevents runaway changes).
4. 4-hour cooldown between evolutions (already implemented in threshold-evolver.js).
5. Log all mutations to `lessons` table with `type: "filter_evolution"`.

**DB note:** `performance` table stores `organic_score`, `fee_tvl_ratio`, `volatility`, `bin_step` — but NOT `minMcap` or `minTop10HolderRate`. The evolution must use available columns.

**GMGN delay:** GMGN API calls use a 2500ms delay between requests (user request).

---

### Section 4 — Cost + Reliability

**Goal:** Reduce LLM calls, standardize timeouts, unify error handling.

**4a) Reduce LLM calls**
- Management already only calls LLM for INSTRUCTION actions (good).
- Screening: quality floor (Section 2a) handles this — no LLM call if no candidate passes `risk_score <= 40 && confidence >= 40`.

**4b) Standardized retries + error taxonomy**
- `withRetry(fn, config)` with exponential backoff across all external requests.
- `classifyError(err)` → `NETWORK | RATE_LIMIT | VALIDATION | UNKNOWN`.
- Applied to: Helius, Meteora positions, Agent Meridian relay.
- GMGN uses fixed 2500ms delay constant, not exponential backoff.
- RATE_LIMIT: retry up to 5× with 5s backoff. VALIDATION: fail immediately, no retry.

**4c) Unified error taxonomy**
- Classify every error into: `NETWORK | RATE_LIMIT | VALIDATION | UNKNOWN`.
- Map each class to a retry strategy.

---

### Section 5 — Ops Hardening

**Goal:** Make the agent observable and recoverable under degraded conditions.

**5a) Health endpoint enrichment**
- Add `last_successful_screening_ts`, `last_successful_management_ts`, `last_error_type`, `last_error_ts` to the `/health` response.
- **Telegram alert** on: (1) new error type detected, (2) last successful screening is stale (>1 hour).
- Timestamps stored as Unix ms; formatted in Asia/Jakarta when displayed.

**5b) Safe mode — block deploy tool only, not screener**
- If 3 hallucination alerts occur within 10 minutes, activate safe mode.
- **Safe mode blocks `deploy_position` tool only** — screening continues normally so real opportunities still get screened and can be manually deployed.
- When `deploy_position` is called in safe mode → returns `{ blocked: true, reason: "safe mode active" }`. LLM sees block, logs it, moves on.
- Telegram notification sent ONLY when safe mode **deactivates** ("Safe mode lifted — deploys re-enabled").
- Manual reset via `/safe-mode off` in Telegram or CLI.
- Also triggers on 3 consecutive failed deploys (tx revert, safety block, etc.) within 10 minutes.

**5c) CLI bin name fix**
- `package.json` CLI `bin` points to `"meridian"` but README and project use `kairos`. Fix to `"kairos"` to prevent operational mistakes on servers.

**5d) Daily performance snapshot**
- Captures every day at midnight Jakarta time: open positions count, realized PnL, unrealized PnL, SOL balance.
- Stored in `daily_snapshots` table.
- Timestamps in Asia/Jakarta timezone.

---

## Implementation Order

1. **Task 1 (Measurement Layer — 3 tables + hooks)** — Must ship first; everything else depends on its data.
2. **Task 2 (config fix: lpAgentRelayEnabled path)** — Quick win, 1 file, no risk.
3. **Task 3 (toxic memory fast-fail: ≥2 losses = toxic)** — High safety impact, low complexity.
4. **Task 4 (quality floor: risk_score <= 40 + exposure cap)** — Medium complexity, high safety impact.
5. **Task 5 (phase range multiplier)** — Medium complexity, PnL impact.
6. **Task 6 (rejection audit trail)** — Depends on Task 1 data; low complexity.
7. **Task 7 (auto filter evolution: MIN=5, GMGN 2500ms)** — Depends on Task 1 data; medium complexity.
8. **Task 9 (retry + error taxonomy: Helius + Meteora + relay)** — Independent; reliability improvement.
9. **Task 10 (CLI bin fix)** — Quick win, no risk.
10. **Task 8 (safe mode: block deploy tool only + health Telegram alert)** — Independent; critical safety.
11. **Task 11 (daily snapshot: Jakarta timezone)** — Independent; bonus observability.

---

## Past Commits Reference (context for design decisions)

| Commit | Hash | Topic |
|--------|------|-------|
| fix: telegram recursive drain, meteora close typo, memory leaks, performance | 9523190 | Memory + leaks |
| use let … enables null cleanup in meteora positions | b2e3774 | Memory micro-op |
| token-only deploy bypass and DRY_RUN env leak | a819c0b | Broken deploys |
| resolve test contamination, telegram infinite loop, repl corruption | 8dfb75c | Hallucination fix |
| LLM deployment hallucination prevention (multiple iterations) | 7902e37, 9a83854, 22ce207, 620edfe | Historical hallucination work |

---

## Key Code Conventions (validated against current codebase)

| Item | Correct | Common Mistake |
|------|---------|--------------|
| DB accessor | `getDB()` from `src/core/db.js` | `getDb()`, `getDB()` from `src/db/schema.js` |
| New tables | Migration in `migrations/` (repo root) | `schema.js`, `init.js` |
| pool_deploys PnL column | `pnl_pct` | `pnl` |
| Simulator risk_score | Higher = MORE risky (additive) | Lower = more risky |
| Simulator pass gate | `risk_score <= 40 && confidence >= 40` | `risk_score >= 30` |
| Telegram exports | `sendHTML`, `sendMessage`, `notifyDeploy`, `drainTelegramQueue` | Making up export names |
| Health endpoint | `src/server/health.js`, `_timersState` from `src/core/state/scheduler-state.js` | `timers` directly |
| GMGN delay | Config `gmgn.requestDelayMs` (current default 350ms), to be overridden to 2500ms | No delay |
| Evolver MIN positions | 5 (user request) | 15 |
| Evolver cooldown | 4 hours (already implemented) | No cooldown |
| Timestamps | Unix ms stored; Asia/Jakarta formatted for display | Not timezone-specified |
