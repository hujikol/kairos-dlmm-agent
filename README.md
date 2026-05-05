# KAIROS

> **Autonomous DLMM LP agent** for Meteora pools on Solana. Screens, deploys, and manages liquidity positions automatically. Controlled via Telegram or CLI.
>
> Built from [Meridian](https://github.com/yunus-0x/meridian) · MIT Licensed

[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/meridian-agents/kairos-dlmm-agent)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/meridian-agents/kairos-dlmm-agent/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17.0-brightgreen?logo=node.js&logoColor=339933)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-green?logo=solana&logoColor=blue-blue)](https://solana.com)
[![Meteora](https://img.shields.io/badge/Meteora-red)](https://meteora.ag)
[![Helius](https://img.shields.io/badge/Helius%20RPC-orange)](https://helius.xyz)
[![Telegram](https://img.shields.io/badge/Telegram-white?logo=telegram&logoColor=blue)](https://core.telegram.org)

## Feature Stack

| | Core | Experimental |
|---|------|-------------|
| **Screening** | Meteora Pool Discovery, token scoring, pool simulation, market phase detection | Technical indicators (RSI, Bollinger, Supertrend, Fibonacci) |
| **Risk Filters** | Bot holders, launchpad blocklist, toxic token memory, bundle detection | — |
| **Management** | Trailing TP, stop-loss, OOR detection, fee auto-swap, circuit breaker | — |
| **Intelligence** | Lessons system, threshold evolution, caveman mode | Hive Mind (collective), Agent Meridian relay |
| **Persistence** | SQLite decision log, performance history, event log | — |
| **Interfaces** | Telegram (10 commands), CLI (20+ subcommands), REPL, health endpoint | — |
| **Reliability** | Busy-state guards, once-per-session blocks, rate-limit retry, JSON repair | — |

---

## What It Does

**Autonomous operation:** runs screening and management cycles on a cron schedule. No manual intervention required — the agent screens new pools, deploys positions, manages exits, claims fees, and swaps rewards to SOL automatically.

**Screening cycle:** fetches top Meteora pools → filters by TVL, volume, organic score, holder count, bin step → checks for bot holders and common-funder bundles → simulates pool deploy for risk/confidence scoring → LLM screener picks the best candidate.

**Management cycle:** fetches all open positions → updates PnL → checks trailing take-profit and stop-loss → detects out-of-range → deterministic rule engine decides CLOSE / CLAIM / STAY / INSTRUCTION → LLM called only when action needed.

**Safety layers:**
- Token blocklist (pool-memory): blocks tokens with >66% loss rate across prior deploys
- Circuit breaker: skips all trading if daily loss limit hit; skips new deploys if daily profit target hit
- Emergency stop-loss: fires immediately on watchdog poll, no LLM needed
- Duplicate deploy guard: blocks same pool and same base_mint twice
- Once-per-session: deploy/swap/close limited to one use per session

**Learning:** every closed position is recorded. After 5+ closes, `evolveThresholds()` adjusts config from actual win/loss patterns. Manual lessons can be added via `/teach add`.

**Hive Mind (experimental):** pulls shared lessons from a collective of agents. Pushes individual performance events back. 15-min background sync with disk cache.

---

## Prerequisites

- **Node.js** >= 20.17.0 or >= 22.9.0
- **Solana wallet** with SOL for gas and position funding
- **OpenRouter API key** for LLM decision-making
- **Solana RPC endpoint** (Helius recommended for production)

Optional:
- **Telegram bot token** (via [@BotFather](https://t.me/BotFather)) for monitoring and control
- **Sentry DSN** for error tracking
- **Agent Meridian relay** for collective intelligence (Hive Mind experimental)

---

## Installation

```bash
cd kairos-dlmm-agent
npm install
cp .env.example .env
npm run setup   # interactive wizard — creates .env and user-config.json
```

---

## Configuration

### `.env` — environment variables

> **Note:** The code accepts both `OPENROUTER_API_KEY` (primary) and `LLM_API_KEY` (local endpoints). Use `OPENROUTER_API_KEY` for OpenRouter; use `LLM_API_KEY` for local LLM servers (LM Studio, OpenAI-compatible).

#### Required

| Variable | Description |
|----------|-------------|
| `WALLET_PRIVATE_KEY` | Solana wallet private key (base58 or JSON array format) |
| `RPC_URL` | Solana RPC endpoint (Helius recommended) |
| `OPENROUTER_API_KEY` | OpenRouter API key (primary; also accepts `LLM_API_KEY` for local endpoints) |

#### Trading / Meteora

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | — | Set to `true` to simulate (no on-chain transactions) |
| `METEORA_COMPUTE_UNIT_LIMIT` | `1400000` | Compute unit limit for Meteora transactions |
| `METEORA_SLIPPAGE_BPS` | `1000` | Slippage in basis points (1000 = 10%) |
| `METEORA_DLMM_API_BASE` | `https://dlmm.datapi.meteora.ag` | Meteora DLMM API base |
| `METEORA_POSITIONS_CACHE_TTL_MS` | `300000` | Positions cache TTL (5 min) |
| `METEORA_CLOSE_SYNC_WAIT_MS` | `5000` | Wait after close before verifying on-chain |
| `METEORA_CLOSE_RETRY_DELAY_MS` | `3000` | Close verification retry delay |
| `PRIORITY_MICRO_LAMPORTS` | `50000` | Priority fee micro-lamports for transactions |

#### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `MiniMax-M2.7` | Override default model |
| `LLM_BASE_URL` | — | Local LLM endpoint (e.g. LM Studio `http://localhost:1234/v1`) |
| `LLM_API_KEY` | — | API key for local endpoints; `OPENROUTER_API_KEY` for OpenRouter |
| `LLM_FALLBACK_MODEL` | `stepfun/step-3.5-flash:free` | Fallback on provider 502/503/529 errors |
| `LLM_TIMEOUT_MS` | `300000` | LLM call timeout (5 min) |
| `MAX_WALL_CLOCK_MS` | `480000` | Agent loop wall-clock timeout (8 min) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base |
| `MINIMAX_BASE_URL` | `https://api.minimax.io/v1` | MiniMax API base |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base |
| `LOCAL_LLM_BASE_URL` | `http://localhost:1234/v1` | Local LLM (LM Studio/Ollama) base |

#### Telegram

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Chat ID to receive notifications and issue commands |
| `TELEGRAM_MSG_DELAY_MS` | `1500` | Delay between Telegram messages |
| `TELEGRAM_POLL_TIMEOUT_MS` | `35000` | Telegram long-poll timeout |

#### External Services

| Variable | Default | Description |
|----------|---------|-------------|
| `HELIUS_API_KEY` | — | Helius API key for enriched wallet/portfolio data |
| `HELIUS_API_BASE` | `https://api.helius.xyz` | Helius API base |
| `JUPITER_API_KEY` | — | Jupiter API key |
| `JUPITER_DATAPI_BASE_URL` | `https://datapi.jup.ag/v1` | Jupiter datapi base |
| `JUPITER_PRICE_API_URL` | `https://api.jup.ag/price/v3` | Jupiter price API |
| `JUPITER_ULTRA_API_URL` | `https://api.jup.ag/ultra/v1` | Jupiter ultra API |
| `JUPITER_QUOTE_API_URL` | `https://api.jup.ag/swap/v1` | Jupiter quote API |
| `LPAGENT_API_KEY` | — | LPAgent API key for studying top LPers |
| `LPAGENT_API_BASE` | `https://api.lpagent.io/open-api/v1` | LPAgent API base |
| `LPAGENT_RATE_LIMIT_BUFFER_MS` | `1000` | Rate limit window buffer |
| `POOL_DISCOVERY_API_BASE` | `https://pool-discovery-api.datapi.meteora.ag` | Meteora pool discovery |
| `OKX_API_BASE` | `https://web3.okx.com` | OKX API base |

#### Agent Meridian / Hive Mind (experimental)

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MERIDIAN_API_URL` | `https://api.agentmeridian.xyz/api` | Primary Agent Meridian relay endpoint |
| `HIVE_MIND_URL` | — | Alternative relay URL (fallback if `AGENT_MERIDIAN_API_URL` not set) |
| `HIVE_MIND_PUBLIC_API_KEY` | — | Primary Hive Mind public API key |
| `HIVE_MIND_API_KEY` | — | Alternative API key (fallback) |
| `HIVE_MIND_SYNC_DEBOUNCE_MS` | `300000` | Hive Mind sync debounce (5 min) |
| `HIVE_MIND_GET_TIMEOUT_MS` | `5000` | Hive Mind GET timeout |
| `HIVE_MIND_POST_TIMEOUT_MS` | `10000` | Hive Mind POST timeout |
| `lpAgentRelayEnabled` | — | Enable relay for PnL/positions (set in `user-config.json`) |

#### Solana RPC

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_BACKOFF_BASE_DELAY_MS` | `1000` | RPC rate-limit backoff base |
| `SOLANA_BACKOFF_MAX_DELAY_MS` | `30000` | RPC backoff max delay |

#### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `text` | Log format: `text` or `json` |
| `LOG_MAX_SIZE` | `10000000` | Bytes per log file before rotation |
| `LOG_MAX_FILES` | `7` | Number of rotated log files to keep |
| `SENTRY_DSN` | — | Sentry error tracking DSN (leave empty to disable) |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Sentry trace sample rate |
| `SENTRY_PROFILES_SAMPLE_RATE` | `0.1` | Sentry profile sample rate |

#### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `KAIROS_DB_PATH` | `src/core/kairos.db` | SQLite DB path (set if running from different CWD) |
| `BACKUP_DEST_DIR` | — | Offsite backup mount path (copied in addition to local `backups/`) |

#### Health / Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PORT` | `3030` | Health endpoint port |
| `BRIEFING_LOOKBACK_MS` | `86400000` | Briefing lookback window (24h) |
| `WATCHDOG_POLL_INTERVAL_MS` | `60000` | Watchdog poll interval (1 min) |

#### Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `CAVEMAN_ENABLED` | `false` | Enable prompt compression (reduces token usage) |

### `user-config.json` — runtime thresholds

Runtime-configurable via `/set` Telegram command or `update_config` tool. Persists across restarts. All keys are validated via `validateAndCoerce(changes)` before apply — invalid keys are rejected outright.

#### Screening Section
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `minFeeActiveTvlRatio` | `0.05` | 0–1 | Minimum fee/TVL ratio for active pools |
| `minTvl` | `10000` | >0 | Minimum pool TVL in USD |
| `maxTvl` | `150000` | >0 | Maximum pool TVL in USD |
| `minVolume` | `500` | >0 | Minimum 24h volume in USD |
| `minOrganic` | `60` | 0–100 | Minimum organic score (0–100) |
| `minHolders` | `500` | ≥0 | Minimum token holder count |
| `minMcap` | `150000` | ≥0 | Minimum market cap in USD |
| `maxMcap` | `10000000` | ≥0 | Maximum market cap in USD |
| `minBinStep` | `80` | ≥1 | Minimum pool bin step |
| `maxBinStep` | `125` | ≥1 | Maximum pool bin step |
| `timeframe` | `"5m"` | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` | Price history timeframe |
| `category` | `"trending"` | string | Pool category filter |
| `minTokenFeesSol` | `30` | ≥0 | Minimum token fees paid in SOL (filters bundled/scam) |
| `maxBundlePct` | `30` | 0–100 | Maximum bundle holder % (OKX) |
| `maxBotHoldersPct` | `30` | 0–100 | Maximum bot holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | 0–100 | Maximum top 10 holder concentration |
| `blockedLaunchpads` | `[]` | array of strings | Blocked launchpad domains (e.g. `["pump.fun"]`) |
| `minTokenAgeHours` | `null` | ≥0 or `null` | Minimum token age (null = no minimum) |
| `maxTokenAgeHours` | `null` | ≥0 or `null` | Maximum token age (null = no maximum) |
| `athFilterPct` | `null` | -100–0 or `null` | Only deploy if price ≥ X% below ATH |
| `slippageBps` | `300` | ≥0 | Slippage in basis points (300 = 3%) |
| `screeningCooldownMs` | `300000` | ≥0 | Cooldown between screening cycles |
| `balanceCacheTtlMs` | `300000` | ≥0 | Helius balance cache TTL |

#### Management Section
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `minClaimAmount` | `5` | ≥0 | Minimum fee amount to claim |
| `autoSwapAfterClaim` | `false` | boolean | Auto-swap claimed fees to SOL |
| `autoSwapAfterClose` | `true` | boolean | Auto-swap position funds to SOL after close |
| `outOfRangeBinsToClose` | `10` | ≥0 | Bins out-of-range before close |
| `outOfRangeWaitMinutes` | `30` | ≥1 | Wait time before closing OOR position |
| `minVolumeToRebalance` | `1000` | ≥0 | Minimum volume to trigger rebalance |
| `stopLossPct` | `-50` | -100–0 | Emergency stop-loss % |
| `takeProfitFeePct` | `5` | ≥0 | Fee-based take-profit % |
| `minFeePerTvl24h` | `7` | ≥0 | Minimum fee per TVL (24h) |
| `minAgeBeforeYieldCheck` | `60` | ≥0 | Minimum position age before yield check |
| `minSolToOpen` | `0.55` | ≥0 | Minimum SOL balance to open position |
| `gasReserve` | `0.2` | ≥0 | SOL reserved for gas |
| `baseDeployAmount` | `0.35` | ≥0.01 | Base deploy amount per position |
| `deployAmountSol` | `0.35` | ≥0.01 | Alias for `baseDeployAmount` |
| `maxDeployAmount` | `50` | ≥0.01 | Maximum deploy amount per position |
| `trailingTakeProfit` | `true` | boolean | Enable volatility-adaptive trailing TP |
| `trailingTriggerPct` | `3` | ≥0 | Trailing TP trigger % |
| `trailingDropPct` | `1.5` | ≥0 | Trailing TP drop % |
| `solMode` | `false` | boolean | Enable SOL-only mode (no token deposit) |
| `pnlSuspectThresholdPct` | `100` | ≥0 | PnL threshold for suspect positions |
| `pnlSuspectMinUsd` | `1` | ≥0 | Minimum USD for suspect check |
| `yieldCheckMinAgeMs` | `86400000` | ≥0 | Minimum position age for yield check |
| `minLlmOutputLen` | `5` | ≥0 | Minimum LLM output length |
| `maxLlmOutputDisplay` | `2000` | ≥0 | Maximum LLM output display length |
| `telegramMaxMsgLen` | `4096` | ≥0 | Maximum Telegram message length |

#### Risk Section
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `maxPositions` | `3` | 1–20 | Maximum open positions |
| `dailyProfitTarget` | `2` | ≥0 | Daily profit target (halts new deploys) |
| `dailyLossLimit` | `-5` | ≤0 | Daily loss limit (halts all trading) |
| `maxPositionsPerToken` | `1` | 1–10 | Maximum positions per token |

#### Schedule Section
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `managementIntervalMin` | `10` (dry: `1`) | 1–1440 | Management cycle interval (minutes) |
| `screeningIntervalMin` | `30` (dry: `1`) | 1–1440 | Screening cycle interval (minutes) |
| `pnlPollIntervalSec` | `30` | ≥1 | PnL poll interval (seconds) |

#### LLM Section
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `temperature` | `0.373` | 0–1 | LLM temperature |
| `maxTokens` | `4096` | ≥1 | Maximum LLM output tokens |
| `maxSteps` | `10` | ≥1 | Maximum agent loop steps |
| `screenerMaxSteps` | `5` | ≥1 | Maximum screener agent steps |
| `managerMaxSteps` | `4` | ≥1 | Maximum manager agent steps |
| `managementModel` | `"MiniMax-M2.7"` | string/`null` | Model for MANAGER role |
| `screeningModel` | `"MiniMax-M2.7"` | string/`null` | Model for SCREENER role |
| `generalModel` | `"MiniMax-M2.7"` | string/`null` | Model for GENERAL role |
| `evolveModel` | `"MiniMax-M2.7"` | string | Model for evolution tasks |

#### Strategy Section
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `strategy` | `"bid_ask"` | string | Active strategy name |
| `binsBelow` | `69` | ≥1 | Bins below active bin |
| `binsAbove` | `5` | ≥0 | Bins above active bin |

#### Other Top-Level Keys
| Key | Default | Valid Values | Description |
|-----|---------|---------------|-------------|
| `lpAgentRelayEnabled` | `false` | boolean | Enable Agent Meridian relay |
| `cavemanEnabled` | `false` | boolean | Enable prompt compression (caveman mode) |

**Note:** `healthCheckIntervalMin` is not a valid config key. Use `WATCHDOG_POLL_INTERVAL_MS` (env var) for watchdog interval, or `managementIntervalMin`/`screeningIntervalMin` for cycle intervals.

---

## Running

### Development (dry run)

```bash
npm run dev
# or
DRY_RUN=true npm start
```

### Production

```bash
# Confirm DRY_RUN is not set (or set to false) in .env
npm start

# With PM2 (recommended)
pm2 start ecosystem.config.js --name kairos
pm2 logs kairos
pm2 restart kairos
pm2 save && pm2 startup   # auto-start on boot
```

### Upgrading

```bash
npm run self-update   # git pull + auto-restart
# or manually:
git pull
npm install
pm2 restart kairos
```

---

## Features

### Autonomous Screening Cycle
- Fetches top candidates from Meteora API
- Hard filters: launchpads, bot holders, toxic tokens, TVL/volume/organic thresholds
- Active bin pre-fetch in parallel
- Market phase detection → phase-matched strategies
- Pool simulation: risk score + confidence score
- Token scoring (0–100): terrible / poor / fair / good / excellent
- LLM screener (role: SCREENER) picks best deploy

### Autonomous Management Cycle
- Fetches all positions + balances
- Deterministic rule engine → CLOSE / CLAIM / STAY / INSTRUCTION
- Trailing take-profit (volatility-adaptive)
- Out-of-range detection + wait-before-close
- Emergency stop-loss (no LLM needed)
- Post-trade: auto-swap fee rewards to SOL
- Circuit breaker: halts on daily loss limit, preserves on daily profit target

### Decision Log
Every deploy / close / skip / claim / learn is recorded to SQLite with reasoning, metadata, and PnL. Auto-prunes at 10k rows and 30 days.

### Technical Indicators (experimental)
Technical indicators computed from Jupiter price history to enrich pool analysis during screening. Implemented in `src/tools/chart-indicators.js`:

| Indicator | Description |
|-----------|-------------|
| RSI (14-period) | Relative Strength Index, measures overbought/oversold conditions |
| Bollinger Bands (20-period, 2σ) | Price bands around SMA, measures volatility |
| Supertrend (10-period ATR) | Trend-following indicator, identifies buy/sell signals |
| Fibonacci Retracement | Key support/resistance levels based on Fibonacci ratios |

Available via `computeRSI`, `computeBollingerBands`, `computeSupertrend`, `computeFibonacciRetracement` tools. Used by the screener to add technical context to candidate evaluation.

### Hive Mind — Experimental
Collective intelligence via Agent Meridian relay. Pulls shared lessons from other agents. Pushes individual performance events. 15-min background sync + startup bootstrap. Enable via `config.hiveMind.url` + `config.hiveMind.apiKey` in `user-config.json`.

### Lessons System
- Records every closed position's outcome
- Tag-ranked retrieval (infers from pair, tvl, oor, pnl_pct, binStep)
- Threshold evolution: adjusts screening/management config from win/loss patterns
- Minimum 5 closed positions before auto-evolution

### Strategy Library
The agent includes a persistent strategy library for saving, activating, and managing LP deployment strategies. Strategies define token criteria, entry conditions, range settings, and exit rules that the screener applies during deployment cycles.

**Available Tools (via ReAct agent, Telegram free-form chat, or REPL):**
- `add_strategy` — Save a new strategy to the library. Parse tweet/description text to extract structured criteria (lp_strategy, token criteria, entry/range/exit rules).
- `list_strategies` — List all saved strategies with summaries, showing which is currently active.
- `get_strategy` — Retrieve full details of a specific strategy by ID.
- `set_active_strategy` — Set which strategy to use for the next screening/deployment cycle.
- `remove_strategy` — Remove a strategy from the library.

**Strategy Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Short slug (e.g. `overnight_classic_bid_ask`) |
| `name` | string | Human-readable name |
| `author` | string | Strategy creator |
| `lp_strategy` | enum | `bid_ask`, `spot`, `curve` |
| `token_criteria` | object | `min_mcap`, `min_age_days`, `requires_kol`, `notes` |
| `entry` | object | `condition`, `price_change_threshold_pct`, `single_side` |
| `range` | object | `type` (tight/default/wide/panda), `bins_below_pct`, `notes` |
| `exit` | object | `take_profit_pct`, `notes` |
| `best_for` | string | Ideal market conditions for this strategy |
| `raw` | string | Original source text (e.g. tweet) |

Note: No dedicated CLI commands or Telegram slash commands exist for strategy management. Use the ReAct agent interface (Telegram free-form chat or REPL) to call strategy tools.

---
### Smart Wallet Tracking
Tools for tracking and analyzing smart wallet activity (implemented in `src/tools/smart-tools.js`):
- `add_smart_wallet` — Add a wallet to the smart wallet list
- `remove_smart_wallet` — Remove a wallet from the list
- `list_smart_wallets` — List all tracked smart wallets
- `check_smart_wallets_on_pool` — Check if smart wallets are active on a specific pool

Used by the SCREENER role to evaluate pool quality based on smart money activity.

### Signal Weights / Darwinian Weights
- `src/core/signal-weights.js`: Tracks which screening signals predict profitable positions. Adjusts weights over time — signals in winners get boosted, those in losers get decayed. Weights persisted in `signal-weights.json`, injected into LLM prompt.
- `src/core/darwin-weights.js`: Thin wrapper that checks `config.darwin.enabled` before invoking `recalculateWeights`. Called from `recordPerformance()`.

### Post-Mortem System
Implemented in `src/core/postmortem.js` (barrel re-export). Runs after every position close (called from `recordPerformance()`):
- Analyzes closed positions against historical performance
- Detects losing patterns, recurring failures, time-of-day patterns
- Produces structured rules injected into SCREENER prompt as hard warnings
- Rules persisted to SQLite `postmortem_rules` table

### OKX Integration
Implemented in `src/integrations/okx.js` (public endpoints, no API key required):
- Uses `Ok-Access-Client-type: agent-cli` header for unauthenticated access
- Provides `getAdvancedInfo`, `getClusterList`, `getRiskFlags` for token analysis
- Protected by a circuit breaker (`createCircuitBreaker`)

### Cache Tools
Stub implementations in `src/tools/cache-tools.js` (not yet fully implemented):
- `clear_cache`: Clear all cached tool data
- `get_cache_info`: Get cache statistics and TTL info
- Note: Read-only tools use `cachedTool()` internally with per-tool TTLs (see Agent System section for TTL table).

---
## Agent System

The agent uses a ReAct (Reasoning + Acting) loop with three distinct roles, each with specific tool access permissions.

### Roles

| Role | Triggered When | Purpose |
|------|----------------|---------|
| `SCREENER` | Screening cycle runs (cron or manual) | Find + deploy new positions |
| `MANAGER` | Management cycle runs (cron or manual) | Manage open positions |
| `GENERAL` | Free-form Telegram chat, REPL input | Chat, manual commands, intent classification |

### Tool Access Per Role

#### MANAGER_TOOLS (manages open positions)
`close_position`, `claim_fees`, `swap_token`, `update_config`, `get_position_pnl`, `get_my_positions`, `set_position_note`, `add_pool_note`, `get_wallet_balance`, `get_wallet_positions`

#### SCREENER_TOOLS (finds new positions)
`deploy_position`, `get_active_bin`, `get_top_candidates`, `check_smart_wallets_on_pool`, `get_token_holders`, `get_token_narrative`, `get_token_info`, `search_pools`, `get_pool_memory`, `add_pool_note`, `add_to_blacklist`, `update_config`, `get_wallet_balance`, `get_my_positions`, `get_wallet_positions`

#### GENERAL (all tools, filtered by intent)
All tools are available, but intent classification narrows the set:
- 16 intent patterns map to tool subsets
- If no intent matches, all tools are available
- Tools are strictly schema-enforced (no additional properties allowed)

### Safety Guards

**`ONCE_PER_SESSION` Guard:**
- Applies to `deploy_position`, `swap_token`, `close_position`
- Each tool can only be called once per agent session
- Resets when a new session starts (management/screening cycle restart)

**Busy-State Guards:**
- `managementBusy`: Prevents concurrent management cycles
- `screeningBusy`: Prevents concurrent screening cycles
- Implemented in `src/core/state/scheduler-state.js`

---

## Monitoring

### Health endpoint

```bash
curl http://localhost:3030/health
```

Returns JSON with uptime, memory usage, and last management cycle timestamp.

### Telegram commands

| Command | Description |
|---------|-------------|
| `/balance` | Show wallet SOL and token balances |
| `/positions` | List all open positions with PnL + OOR warnings |
| `/close <n>` | Close position by its list number |
| `/set <n> <note>` | Attach an instruction to a position |
| `/swap-all` | Sweep all tokens to SOL |
| `/briefing` | Daily morning briefing (HTML) |
| `/status` | Combined positions + wallet status |
| `/candidates` | Re-screen and display top 5 candidates |
| `/screen` | Trigger manual screening cycle |
| `/learn` or `/learn <addr>` | Study top LPers via LPAgent |
| `/thresholds` | Show all thresholds + performance stats |
| `/evolve` | Manually trigger threshold evolution |
| `/caveman` | Toggle prompt compression mode |
| `/teach pin\|unpin\|rate\|stats\|list [role]` | Manage lessons |
| `/teach add <rule> [--pinned] [--role=manager]` | Add a manual lesson |
| `/teach clear all\|performance\|keyword <kw>` | Clear lessons |

**`ONCE_PER_SESSION`** — `deploy_position`, `swap_token`, `close_position` are blocked after first use per session.

### REPL commands (interactive mode)

| Command | Description |
|---------|-------------|
| `auto` | Run agent loop to pick best pool and deploy |
| `screen` | Manually trigger a screening cycle |
| `go` | Start the cron scheduler (auto-management) |
| `/status`, `/candidates`, `/learn`, `/thresholds`, `/evolve` | Same as Telegram |
| `/stop` | Graceful shutdown |

---

## Position Sizing

```
effective deploy = clamp(deployable_sol * deployAmountSol, floor=deployAmountSol, ceil=maxDeployAmount)
```

`deployAmountSol=0.1` → minimum 0.1 SOL per position regardless of wallet size, capped at `maxDeployAmount`.

---

## Troubleshooting

### Bot not responding to Telegram
- Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`
- Send `/start` to the bot in Telegram

### Positions not deploying
- Confirm `DRY_RUN` is unset or `false`
- Check SOL balance via `/balance`
- Verify `RPC_URL` is accessible and not rate-limited

### Screener finds no pools
- Check RPC rate limit capacity
- Thresholds in `user-config.json` may be too restrictive — run `/thresholds`
- Try `/screen` to see raw screener output

### High memory usage
- PM2 `max_memory_restart` defaults to 512MB
- Prune old logs: `logs/`, `backups/`

### Database recovery
```bash
cp backups/kairos-YYYY-MM-DD.db src/core/kairos.db
pm2 restart kairos
```

---

## Available Scripts

| Script | Purpose |
|--------|---------|
| `npm run setup` | Interactive first-run wizard |
| `npm start` | Start the agent |
| `npm run dev` | Start in dry-run mode |
| `npm run self-update` | git pull + auto-restart |
| `npm test` | Run tests |
| `npm run test:screen` | Test screening flow |
| `npm run test:agent` | Test agent loop |

## CLI (alternative to REPL)

```bash
# Wallet & positions
kairos balance                   # Wallet SOL + token breakdown
kairos positions                 # Open positions with PnL
kairos pnl                       # Closed position performance
kairos wallet-positions          # Wallet positions (alternative view)

# Screening & discovery
kairos screen                    # Run screening cycle
kairos candidates                # List top pool candidates
kairos pool-detail <addr>        # Pool details + indicators
kairos search-pools <query>        # Search Meteora pools
kairos active-bin <pool>           # Get active bin for a pool
kairos study <pool|token>         # Study top LPers via LPAgent

# Trading actions
kairos manage                    # Run management cycle
kairos deploy <pool> <amount>     # Deploy to a pool
kairos close <n>                  # Close position by index
kairos claim <n>                  # Claim fees from position
kairos swap <from> <to> <amt>     # Swap tokens via Jupiter

# Token analysis
kairos token-info <mint>           # Token info + OKX enrichment
kairos token-holders <mint>        # Token holder analysis
kairos token-narrative <mint>      # Token narrative from OKX

# Config & learning
kairos config get <key>            # Read config value
kairos config set <key> <val>      # Write config value
kairos lessons list|stats|add     # Manage learning system
kairos evolve                     # Trigger threshold evolution
kairos pool-memory list|show        # Pool deploy history + memory
kairos blacklist list|add|remove # Token blacklist management
kairos performance                # Full performance history

# Control
kairos start                      # Start autonomous cycles
```
