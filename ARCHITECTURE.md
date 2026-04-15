# Meridian — Architecture

## System Overview

```
┌──────────────────────────────────────────────────────┐
│                     index.js                         │
│  REPL + cron orchestration + Telegram polling         │
└──────────────┬───────────────────┬────────────────────┘
               │                   │
      ┌────────▼────────┐  ┌──────▼──────┐
      │  scheduler.js   │  │telegram.js  │
      │  (cron jobs)    │  │(notifications)│
      └─────────────────┘  └─────────────┘
```

## Core Data Flow

```
RPC (Solana) ←→ meteora.js (DLMM deploy/close/claim)
                    ↓
              state.js (SQLite position registry)
                    ↓
              lessons.js + threshold-evolver.js (learning)
                    ↓
              Telegram + REPL (human feedback)
```

## Modules

### Entry Point
| File | Responsibility |
|------|---------------|
| `src/index.js` | REPL, cron scheduling, Telegram polling, startup/shutdown |
| `src/core/scheduler.js` | Cron job registry and launch |

### Agent
| File | Responsibility |
|------|---------------|
| `src/agent.js` | ReAct loop — LLM → intent detection → tool call → repeat (MAX_REACT_DEPTH=6) |
| `src/tools/executor.js` | Tool name → function dispatch, safety checks |
| `src/tools/definitions.js` | OpenAI-format tool schemas |
| `src/prompt.js` | System prompt builder per role (SCREENER/MANAGER/GENERAL) |
| `src/tools/caveman.js` | Filler stripper for prompt compression |

### Integrations
| File | Responsibility |
|------|---------------|
| `src/integrations/meteora.js` | DLMM pool: deploy, close, claim, positions, PnL |
| `src/integrations/helius.js` | Wallet balances, Jupiter swaps, TTL cache |
| `src/integrations/solana.js` | Shared RPC connection |
| `src/integrations/lpagent.js` | LPAgent API for studying top LPers |

### Screening
| File | Responsibility |
|------|---------------|
| `src/screening/discovery.js` | Pool discovery from Meteora API, filtering |

### Learning
| File | Responsibility |
|------|---------------|
| `src/core/lessons.js` | Learning facade + lesson CRUD |
| `src/core/lesson-repo.js` | Lesson table CRUD + retrieval |
| `src/core/threshold-evolver.js` | Threshold evolution algorithm |
| `src/core/patterns.js` | Pattern recognition engine |
| `src/core/postmortem.js` | Post-close analysis |

### State
| File | Responsibility |
|------|---------------|
| `src/core/state.js` | SQLite position registry |
| `src/core/db.js` | Database connection |

### Notifications
| File | Responsibility |
|------|---------------|
| `src/notifications/telegram.js` | Telegram bot polling |
| `src/notifications/queue.js` | Notification queue, batching |
| `src/notifications/briefing.js` | Daily briefing HTML generator |

### Risk Management
| File | Responsibility |
|------|---------------|
| `src/watchdog.js` | 60s polling for emergency loss conditions |
| `src/core/daily-tracker.js` | Daily PnL circuit breaker |
| `src/core/simulator.js` | Pre-deployment simulator |

### Supporting
| File | Responsibility |
|------|---------------|
| `src/tools/addrShort.js` | Address display shortening (4...4) |
| `src/tools/cache.js` | Unified TTL cache |
| `src/features/pool-memory.js` | Per-pool deploy history |
| `src/features/token-blacklist.js` | Token blacklist |
| `src/features/dev-blocklist.js` | Developer blacklist |
| `src/features/hive-mind.js` | Collective intelligence sync |
| `src/core/logger.js` | Log rotation |

## Database Schema (SQLite — `kairos.db`)

```sql
-- Key-Value store (lastBriefingDate, lastUpdated, etc.)
CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE positions (
  position TEXT PRIMARY KEY,   -- Meteora position address
  pool TEXT,                   -- Pool address
  pool_name TEXT,
  strategy TEXT,
  bin_range TEXT,
  amount_sol REAL,
  amount_x REAL,
  active_bin_at_deploy INTEGER,
  bin_step INTEGER,
  volatility REAL,
  fee_tvl_ratio REAL,
  organic_score REAL,
  initial_value_usd REAL,
  signal_snapshot TEXT,        -- JSON
  base_mint TEXT,
  deployed_at TEXT,
  out_of_range_since TEXT,
  last_claim_at TEXT,
  total_fees_claimed_usd REAL,
  rebalance_count INTEGER,
  closed INTEGER,              -- 0 or 1
  closed_at TEXT,
  notes TEXT,                  -- JSON array
  peak_pnl_pct REAL,
  prev_pnl_pct REAL,
  trailing_active INTEGER,
  instruction TEXT,
  status TEXT DEFAULT 'active', -- 'pending' | 'active' | 'closed'
  market_phase TEXT,
  strategy_id TEXT
);

CREATE TABLE recent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT, action TEXT, position TEXT,
  pool_name TEXT, reason TEXT
);

CREATE TABLE performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT, pool TEXT, pool_name TEXT,
  strategy TEXT, bin_range TEXT,
  bin_step INTEGER, volatility REAL,
  fee_tvl_ratio REAL, organic_score REAL,
  amount_sol REAL, fees_earned_usd REAL,
  final_value_usd REAL, initial_value_usd REAL,
  minutes_in_range REAL, minutes_held REAL,
  pnl_usd REAL, pnl_pct REAL, range_efficiency REAL,
  close_reason TEXT, deployed_at TEXT, closed_at TEXT,
  recorded_at TEXT, base_mint TEXT
);

CREATE TABLE lessons (
  id TEXT PRIMARY KEY,          -- UUID
  rule TEXT, tags TEXT,         -- JSON
  outcome TEXT, context TEXT,   -- JSON
  pnl_pct REAL, range_efficiency REAL,
  pool TEXT,
  created_at TEXT,
  pinned INTEGER DEFAULT 0,
  role TEXT,
  rating TEXT,                  -- 'useful' | 'useless'
  rating_at TEXT
);

CREATE TABLE near_misses (
  id TEXT PRIMARY KEY,
  position TEXT, pool TEXT, strategy TEXT,
  bin_step INTEGER, volatility REAL,
  fee_tvl_ratio REAL, organic_score REAL,
  pnl_usd REAL, pnl_pct REAL,
  minutes_in_range REAL, minutes_held REAL,
  range_efficiency REAL, close_reason TEXT,
  created_at TEXT, reviewed INTEGER DEFAULT 0
);

CREATE TABLE performance_archive (
  -- Same schema as performance, plus archived_at
  id INTEGER PRIMARY KEY,
  position TEXT, pool TEXT, pool_name TEXT,
  strategy TEXT, bin_range TEXT,
  bin_step INTEGER, volatility REAL,
  fee_tvl_ratio REAL, organic_score REAL,
  amount_sol REAL, fees_earned_usd REAL,
  final_value_usd REAL, initial_value_usd REAL,
  minutes_in_range REAL, minutes_held REAL,
  pnl_usd REAL, pnl_pct REAL, range_efficiency REAL,
  close_reason TEXT, deployed_at TEXT, closed_at TEXT,
  recorded_at TEXT, base_mint TEXT,
  archived_at TEXT
);

CREATE TABLE pool_memory (
  pool_address TEXT PRIMARY KEY,
  name TEXT, base_mint TEXT,
  total_deploys INTEGER, avg_pnl_pct REAL,
  win_rate REAL, last_deployed_at TEXT,
  last_outcome TEXT, notes TEXT,        -- JSON array
  cooldown_until TEXT
);

CREATE TABLE pool_deploys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT,
  deployed_at TEXT, closed_at TEXT,
  pnl_pct REAL, pnl_usd REAL,
  range_efficiency REAL, minutes_held REAL,
  close_reason TEXT, strategy TEXT,
  volatility_at_deploy REAL,
  FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
);

CREATE TABLE pool_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT, ts TEXT,
  position TEXT,
  pnl_pct REAL, pnl_usd REAL,
  in_range INTEGER,              -- BOOLEAN
  unclaimed_fees_usd REAL,
  minutes_out_of_range INTEGER,
  age_minutes REAL,
  FOREIGN KEY (pool_address) REFERENCES pool_memory(pool_address) ON DELETE CASCADE
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT, author TEXT, lp_strategy TEXT,
  token_criteria TEXT,           -- JSON
  entry TEXT, range TEXT, exit TEXT, -- JSON
  best_for TEXT, raw TEXT,
  added_at TEXT, updated_at TEXT,
  -- Phase 13 nullable columns (ALTER'd for existing tables):
  phase TEXT,                   -- 'any'|'pump'|'pullback'|'runner'|'bear'|'bull'|'consolidation'
  bin_count INTEGER,
  fee_tier_target REAL,
  max_hold_hours INTEGER,
  confidence INTEGER DEFAULT 0
);

CREATE TABLE signal_weights (
  id INTEGER PRIMARY KEY DEFAULT 1,   -- singleton
  weights TEXT,               -- JSON
  last_recalc TEXT,
  recalc_count INTEGER
);

CREATE TABLE signal_weights_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT, changes TEXT, -- JSON
  window_size INTEGER,
  win_count INTEGER, loss_count INTEGER
);

CREATE TABLE token_blacklist (
  mint TEXT PRIMARY KEY,
  symbol TEXT, reason TEXT,
  added_at TEXT, added_by TEXT
);

CREATE TABLE dev_blocklist (
  wallet TEXT PRIMARY KEY,
  label TEXT, reason TEXT,
  added_at TEXT
);

CREATE TABLE smart_wallets (
  address TEXT PRIMARY KEY,
  name TEXT, added_at TEXT
);

CREATE TABLE postmortem_rules (
  key TEXT PRIMARY KEY,
  type TEXT, strategy TEXT,
  bin_step_range TEXT,          -- JSON
  volatility_range TEXT,         -- JSON
  reason TEXT, frequency INTEGER,
  count INTEGER, hours_utc TEXT, -- JSON
  win_rate INTEGER, sample_size INTEGER,
  evidence TEXT,                 -- JSON
  severity TEXT,
  description TEXT,
  suggestion TEXT,
  created_at TEXT, updated_at TEXT
);
```

## Circular Lazy Imports

The module graph contains two intentional circular dependencies that are resolved
with dynamic (`import()`) lazy loading.  Static analysis tools cannot see these
cycles — the graph is only valid at runtime.

### Pattern 1: `scheduler.js ↔ index.js`

```
index.js (top-level)  ─── imports ──→  scheduler.js
      ↑                                      │
      └── lazy import (getCycles) ── runManagementCycle / runScreeningCycle
```

`scheduler.js` needs `runManagementCycle` and `runScreeningCycle` from `index.js`,
but `index.js` imports `scheduler.js` at top level (for `timers`, `_managementBusy`,
`_screeningBusy`, etc.).  The cycle is broken by importing the two cycle
functions lazily inside `startCronJobs()` via `getCycles()` (scheduler.js line 91).

**Rule:** Never add a top-level `import ... from "../index.js"` or
`import ... from "./orchestration.js"` in `scheduler.js`.  If you need a function
from `index.js` in a new code path, call it lazily via `getCycles()` or extract
the needed function into a third file with no index.js dependency.

### Pattern 2: `pool.js → state/index.js` (lazy)

`src/integrations/meteora/pool.js` uses a lazy import at line 181 to call
`getTrackedPosition` from `state/index.js`.  This avoids pulling `state/index.js`
(and its SQLite dependencies) into memory when the Meteora SDK is loaded statically.
No reverse path exists — `state/index.js` does not import pool.js — so this is a
one-way lazy load rather than a true cycle.  It is documented here for
completeness because the pattern is the same.

### General Rule

When refactoring code in this codebase:
- **Never** add a top-level import of `scheduler.js` in `index.js` or any module
  that `index.js` transitively imports at top level.
- If a refactor requires a function from `scheduler.js` in a new context, extract
  it to a shared utility file with no circular dependencies, or use a lazy import.
- When using lazy imports (`import(...)`), keep them close to the call site so
  reviewers can spot potential cycles.

## Config System

`user-config.json` is the runtime config file. Config object is loaded at startup by `config.js`.

**Valid keys:** screening thresholds, management settings, LLM model names, schedule intervals.

`update_config` tool persists changes to `user-config.json` and reloads thresholds in-memory.

## Agent Roles

| Role | Trigger | Allowed Tools |
|------|---------|---------------|
| SCREENER | Cycle or `/screen` | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| MANAGER | Cycle or `/positions` | close_position, claim_fees, swap_token, get_position_pnl |
| GENERAL | Chat or `/` | All tools |

## Test Files

| File | Coverage |
|------|----------|
| `test-evolve.js` | threshold-evolver.js |
| `test-management-cycle.mjs` | Integration tests |
| `test-screening.js` | Screening flow |
| `test-agent.js` | Agent intent detection |
