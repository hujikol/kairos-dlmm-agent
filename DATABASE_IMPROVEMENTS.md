# Database Improvements — Analysis & Recommendations

## Schema Overview

| Table | Purpose | Records |
|---|---|---|
| `kv_store` | General-purpose key-value store | 3 keys used |
| `positions` | Position registry (deploy metadata, state, status) | Write=deploy, Read=management/prompt |
| `recent_events` | Last-20 event log shown in agent prompt | Auto-trimmed on insert |
| `performance` | Closed-position performance records | Written on close, read for lessons/evolution |
| `lessons` | Derived learn rules (auto + manual) | Read by prompts, evolution |
| `pool_memory` | Per-pool deploy summary + notes + cooldown | Read before deploy |
| `pool_deploys` | Individual deploy records per pool | Written by pool-memory |
| `pool_snapshots` | Periodic position state snapshots (last 48) | Written by management cycle |
| `strategies` | LP strategy definitions | Read by screening |
| `signal_weights` | Current Darwinian signal weights | Read/written by signal-weights.js |
| `signal_weights_history` | Weight change audit trail | Written by recalc |
| `token_blacklist` | Blacklisted token mints | Checked before screening |
| `dev_blocklist` | Blocked deployer wallets | Checked before screening |
| `smart_wallets` | Tracked KOL/alpha wallets | Read by screening |
| `migrations` | Migration tracking table | Auto-managed |

---

## Removed Columns (Migration 003)

| Table | Column | Reason |
|---|---|---|
| `positions` | `initial_fee_tvl_24h` | Always identical to `fee_tvl_ratio` at deploy. 0 logic uses it independently. |
| `smart_wallets` | `type` | Defaulted to `'lp'`, never set to different value or queried. |
| `smart_wallets` | `category` | Defaulted to `'alpha'`, never set to different value or queried. |

### Reconsidered for Removal (Actually Used)

| Table | Column | Why Preserved |
|---|---|---|
| `positions` | `amount_x` | Passed to Meteora DLMM SDK on-chain deploy. Tool param used by LLM. CLI flag support (`--amount-x`). |
| `positions` | `last_claim_at` | Read in `meteora.js:641` to prevent double-claiming fees on close (60s cooldown check). |

---

## Known Issues (Not Fixed)

### 1. `closed` vs `status` — Duplicate State
`positions.closed INTEGER` and `positions.status TEXT` represent the same state machine. 20+ references to `closed = 0` across 8 files make migration risky. Future cleanup: deprecate `closed`, use `status` only.

### 2. Data Duplication: `positions` vs `performance`
After close, `performance` re-stores most columns from `positions` (`bin_step`, `volatility`, `strategy`, `bin_range`, etc.). If the two ever diverge, it's unclear which is authoritative. Recommendation: add FK reference instead of denormalization, or document that `performance` is the authoritative close-time snapshot.

### 3. `lessons.role` Never Populated
Column exists with an index but is always `NULL` in inserts (via `derivLesson`, `addLesson`, `evolveThresholds`). The `listLessons()` filter handles NULL gracefully, but the column and index provide no value until someone actually calls `addLesson({ role: "SCREENER" })`.

### 4. `lessons.pnl_pct` / `lessons.range_efficiency` Partially Populated
Only populated via `derivLesson()` (auto-derived from performance). NULL for manual lessons and evolution lessons. This makes aggregation across all lessons misleading.

---

## Stale Files Removed

- `meridian.db` (root) — not used by code
- `src/meridian.db` — not used by code

Active database: `src/core/meridian.db`

---

## Learning System Gaps & Recommendations

### Gap 1: No Screen Rejection Tracking
When the screener discovers 50 pools but only 10 pass hard filters, the 40 rejected pools are discarded with no record. The agent can't learn from near-misses or understand filter effectiveness.

**Recommendation**: Add a `screening_log` table:
```sql
CREATE TABLE screening_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  pool_address TEXT,
  pool_name TEXT,
  passed INTEGER, -- 1 if candidate made it to LLM, 0 if rejected
  rejection_reason TEXT, -- e.g. "blacklist", "ath_filter", "toxic"
  metrics_snapshot TEXT -- JSON of key metrics at screening time
);
```
Populate in `getTopCandidates()` (`src/screening/discovery.js`). Useful to track filter hit rates and identify overly aggressive/lenient thresholds.

### Gap 2: No LLM Decision Tracking
When the LLM calls `close_position` or `claim_fees`, the reasoning exists only in the unstructured conversation logs. There's no structured way to query "was this decision correct?" or "what's the agent's close accuracy?"

**Recommendation**: Add an `agent_decisions` table:
```sql
CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY, -- UUID
  role TEXT,           -- 'SCREENER' / 'MANAGER'
  action TEXT,         -- 'deploy' / 'close' / 'claim' / 'swap'
  target TEXT,         -- position_address or pool_address
  reasoning TEXT,      -- LLM's stated reason
  outcome TEXT,        -- 'success' / 'failed' / 'blocked'
  timestamp TEXT
);
```
Populate in `executeTool()` (`src/tools/executor.js`) with the tool name, result, and LLM reasoning extracted from the conversation.

### Gap 3: No Tool Performance History in DB
Tool results are logged to JSONL files (`logs/actions-*.jsonl`). Not queryable via SQL, not available for the LLM to reflect on its own tool usage patterns.

**Recommendation**: Add a `tool_calls` table:
```sql
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  tool_name TEXT,
  args TEXT,
  success INTEGER,
  duration_ms INTEGER,
  error TEXT
);
```
Or alternatively, move the existing JSONL pipeline to write to DB as well.

### Gap 4: Briefing is One-Way
`generateBriefing()` sends to Telegram but there's no record of whether the user read it, and no tracking of which briefing items led to action. The agent doesn't know if the human intervened.

**Recommendation**:
- Log briefing sends in `kv_store` (`_lastBriefingSent`)
- Track user command responses post-briefing to correlate with briefing content

### Gap 5: Post-mortem Rules in JSON, Not DB
`src/core/postmortem.js` writes to `postmortem-rules.json` instead of the database. This means post-mortem rules aren't available for LLM queries (other than file read during prompt injection) and can't be synced via Hive Mind.

**Recommendation**: Add a `postmortem_rules` table with schema from `postmortem.js` rule objects. Migrate existing `postmortem-rules.json` on startup.

### Gap 6: No Position Lifecycle Event Log
There's no structured event log for position lifecycle events (deploy → claim → OOR → rebalance → close). Events are tracked ad-hoc in `recent_events` (last 20 only) and `pool_snapshots` (last 48 per pool).

**Recommendation**: Add an `position_events` table:
```sql
CREATE TABLE position_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT,
  event_type TEXT,  -- 'deploy', 'claim', 'oor_entry', 'oor_exit', 'rebalance', 'set_note', 'close'
  data TEXT,         -- JSON
  ts TEXT
);
```
This enables replay, audit, and post-mortem analysis of the full position lifecycle.

### Gap 7: Hive Mind Consensus Data Never Used in Prompts
`hive-mind.js` has functional query APIs (`queryPoolConsensus`, `queryLessonConsensus`, `queryThresholdConsensus`, `queryPatternConsensus`) and `formatPoolConsensusForPrompt`. But `formatPoolConsensusForPrompt` is **never called** anywhere in the codebase. Data upload works (called from lessons.js line 130), but received consensus is never injected into the agent's decision prompts.

**Recommendation**: Wire `formatPoolConsensusForPrompt()` into the screening cycle prompt. Call `queryPoolConsensus()` for each passing candidate before building candidate blocks. This would add cross-agent intelligence to the LLM's decision-making.

---

## Data Consistency Issues

### 1. `performance` vs `positions` Divergence
Both tables store deploy-time metadata (`bin_step`, `volatility`, `strategy`, etc.). If the position's data were ever updated after deploy (e.g., a note about strategy change), `performance` would still have the original values at close time.

**Current behavior**: `performance` captures the snapshot from `positions` at close time via `recordPerformance()`, so they should be consistent. But there's no FK constraint linking them.

**Recommendation**: Add `FOREIGN KEY (position) REFERENCES positions(position)` to the `performance` table (requires migration since SQLite doesn't support adding FK to existing columns).

### 2. `pool_deploys` / `pool_snapshots` FK Constraints
Both tables declare `FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE` in the DDL. `PRAGMA foreign_keys = ON` is set in `db.js`, so these ARE enforced at runtime. This is already correct.

### 3. No Cascade for `positions` → `performance`
When a position is deleted, its performance record remains orphaned. This is arguably correct (performance should survive for analytics), but worth noting.

---

## Future Enhancement Ideas

### 1. `tool_calls` Table for Analytics
Move tool action audit from JSONL to a queryable table. This enables:
- "Which tools does the LLM call most?"
- "What's the average PnL of positions where the agent chose to close vs stay?"
- "How accurate is the LLM's reasoning vs actual outcomes?"

### 2. `postmortem_rules` Table Integration
Migrate `postmortem-rules.json` to `src/core/db.js` managed table. Benefits:
- Queryable by LLM (via tool, not file read)
- Syncable via Hive Mind
- Trackable: when rules were created, which positions triggered them

### 3. `position_events` Lifecycle Table
Track every meaningful state change as an event in a dedicated table. Enables:
- Position timeline reconstruction
- "How long between deploy and first claim?"
- "How often does this position go OOR vs close directly?"

---

## Active Keys in `kv_store`

Only 3 keys are ever used:

| Key | Purpose |
|---|---|
| `lastUpdated` | Timestamp of last state mutation |
| `_lastBriefingDate` | Last daily briefing date (YYYY-MM-DD) |
| `active_strategy` | Currently active strategy ID |

The table is designed as open-ended K/V, so this is fine.

---

## Applied Changes

### Code changes

| File | Change |
|---|---|
| `src/core/db.js` | Removed `initial_fee_tvl_24h` from positions DDL; removed `category`, `type` from smart_wallets DDL |
| `src/core/state.js` | Removed `initial_fee_tvl_24h` from position INSERT; replaced with `fee_tvl_ratio` in getStateSummary |
| `src/features/smart-wallets.js` | Removed `category`, `type` params from addSmartWallet; removed LP-type filter in checkSmartWalletsOnPool |
| `src/tools/definitions.js` | Removed `category`, `type` params from add_smart_wallet tool definition |
| `migrations/003-drop-dead-columns.sql` | Created migration to drop columns from existing SQLite DB |
| `meridian.db`, `src/meridian.db` | Deleted stale files |
