# Meridian — Architecture

## System Overview

```
┌──────────────────────────────────────────────────────┐
│                     index.js                         │
│  REPL + cron orchestration + Telegram polling         │
└──────────────┬───────────────────┬────────────────────┘
               │                   │
      ┌────────▼────────┐  ┌──────▼──────┐
      │  scheduler.js   │  │telegram-    │
      │  (cron jobs)    │  │poller.js    │
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

## Database Schema (SQLite — `meridian.db`)

```sql
CREATE TABLE positions (
  position TEXT PRIMARY KEY,   -- Meteora position address
  pool TEXT,                   -- Pool address
  status TEXT,                 -- 'pending' | 'active' | 'closed'
  deployed_at TEXT,
  oor_since TEXT,              -- first out-of-range timestamp
  notes TEXT
);

CREATE TABLE performance (
  position TEXT PRIMARY KEY,
  pool TEXT, pool_name TEXT,
  strategy TEXT, bin_range TEXT,
  bin_step REAL, volatility REAL,
  fee_tvl_ratio REAL, organic_score REAL,
  amount_sol REAL, fees_earned_usd REAL,
  final_value_usd REAL, initial_value_usd REAL,
  minutes_in_range INTEGER, minutes_held INTEGER,
  pnl_usd REAL, pnl_pct REAL, range_efficiency REAL,
  close_reason TEXT, deployed_at TEXT, closed_at TEXT, recorded_at TEXT
);

CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  rule TEXT, tags TEXT, outcome TEXT,
  pinned INTEGER, role TEXT,
  rating TEXT, rating_at TEXT,
  created_at TEXT,
  weight REAL DEFAULT 1.0,
  used_count INTEGER DEFAULT 0
);

CREATE TABLE near_misses (
  id TEXT PRIMARY KEY,
  position TEXT, pool TEXT, strategy TEXT,
  pnl_pct REAL, range_efficiency REAL,
  ...
);

CREATE TABLE pool_memory (
  pool_address TEXT PRIMARY KEY,
  name TEXT, base_mint TEXT,
  total_deploys INTEGER, avg_pnl_pct REAL,
  win_rate REAL, last_deployed_at TEXT,
  last_outcome TEXT, notes TEXT,
  cooldown_until TEXT
);
```

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
