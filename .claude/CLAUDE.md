# Kairos — CLAUDE.md

Autonomous DLMM LP agent for Meteora pools on Solana. Forked from Meridian.

---

## Quick Reference

```
src/
├── agent/          ReAct loop (intent, fallback, rate-limit, JSON repair)
├── core/           Engine: cycles, scheduler, state, learning, strategies
│   ├── state/     Position registry, OOR tracking, PnL/trailing TP, events, sync
│   └── pool-indicators.js  Jupiter price history → technical indicators
├── features/       Pool memory, hive-mind (experimental: pull/push), smart-wallets, blacklists
├── integrations/   Helius, Jupiter, Meteora, OKX, LPAgent, Solana
├── notifications/  Telegram bot, briefing generator, notification queue
├── screening/      Pool discovery from Meteora API
├── server/         Health endpoint, graceful shutdown
└── tools/          Tool definitions, executor, per-domain modules
    ├── agent-meridian.js  Centralized relay client (PnL, Top-LP, positions)
    └── chart-indicators.js  RSI, Bollinger Bands, Supertrend, Fibonacci

cycles.js          Canonical — scheduler/watchdog/index.js use this
```

---

## Entry Points

| File | Role |
|------|------|
| `index.js` | Main: REPL + cron orchestration + Telegram polling |
| `cli.js` | Standalone CLI (`kairos <subcommand>`) — 40+ subcommands |
| `repl.js` | REPL line handler: number-pick deploy, slash commands |
| `watchdog.js` | 60s polling for emergency loss → triggers management cycle directly |
| `telegram-handlers.js` | Telegram bot: 9 commands + free-form LLM chat |
| `setup.js` | Interactive first-run wizard |

---

## Core Cycle System

**`cycles.js`** is canonical — all runtime entry points import from here:
- `scheduler.js` — cron triggers (`startCronJobs` / `stopCronJobs`)
- `watchdog.js` — emergency polling
- `index.js` — main entry
- `telegram-handlers.js` — imports from `cycles.js` (merged from `orchestration.js` 2026-04-15)

**`_busyState` object** — Node.js v24.14.1 regressed exported `let` bindings (read-only when imported). All busy flags (`_managementBusy`, `_screeningBusy`) live in `scheduler._busyState` and are accessed as `._managementBusy` / `._screeningBusy`.

### `runManagementCycle()`
- Fetches positions + balances
- Deterministic rule engine → action map (CLOSE/CLAIM/STAY/INSTRUCTION)
- JS trailing TP check via `updatePnlAndCheckExits`
- Calls LLM only if action needed (role: MANAGER)
- Post-trade: `autoSwapRewardFees()`
- Triggers screening cycle if under max positions
- Circuit breaker: halt (daily loss limit) or preserve (daily profit target met)

### `runScreeningCycle()`
- Pre-checks: max positions, SOL balance
- `getTopCandidates()` → per-candidate token recon (`fetchAndReconCandidates`)
- Hard filters: launchpads, bots, toxic tokens (pool-memory)
- Active bin pre-fetch in parallel
- Market phase detection → phase-matched strategies
- `simulatePoolDeploy()` → confidence + risk score per candidate
- Token scoring (`computeTokenScore`) — filters to GOOD/EXCELLENT
- Calls LLM (role: SCREENER) with ranked candidates

### `scheduler.js` — Cron Jobs
| Job | Interval | Function |
|-----|----------|----------|
| Management | `*/managementIntervalMin` min | `runManagementCycle()` |
| Screening | `*/screeningIntervalMin` min | `runScreeningCycle()` |
| Briefing | `0 1 * * *` UTC | `runBriefing()` |
| Briefing watchdog | `0 */6 * * *` UTC | `maybeRunMissedBriefing()` |
| PnL poller | 30s | `updatePnlAndCheckExits` per position, triggers management on exit signal |

---

## State System (`src/core/state/`)

| Module | Responsibility |
|--------|---------------|
| `registry.js` | Position CRUD: `trackPosition`, `updatePositionStatus`, `recordClose`, `recordRebalance`, `recordClaim`, `setPositionInstruction`, `getStateSummary` |
| `oor.js` | OOR single source of truth: `markOutOfRange`, `markInRange`, `minutesOutOfRange` |
| `pnl.js` | `updatePnlAndCheckExits` — peak_pnl, volatility-adaptive trailing TP, 4 exit signals |
| `events.js` | Event log: `pushEvent`, `getRecentEvents` |
| `sync.js` | `syncOpenPositions` — on-chain state reconciliation |

## Decision Log (`src/core/decision-log.js`)

SQLite-backed decision recorder. Auto-prunes at 10k rows and 30 days.

`recordDecision({ type, pool, position, amount, pnl, reasoning, metadata, initiatedBy })` — records deploy/close/skip/claim/learn.

`getDecisions({ pool, limit, type, hours })` — query recent decisions.

Decision types: `deploy` | `close` | `skip` | `claim` | `learn`.

---

## ReAct Agent (`src/agent/`)

| File | Purpose |
|------|---------|
| `react.js` | Core loop: MAX_REACT_DEPTH=6, MAX_TOOL_CALLS_PER_STEP=10, caveman compression, once-per-session tool blocking, rate-limit retry, 120s wall-clock timeout |
| `intent.js` | 16 intent patterns → tool subsets for GENERAL role; DEFAULT_MODEL / FALLBACK_MODEL |
| `fallback.js` | OpenAI client (OpenRouter/LM Studio), `callWithRetry` — 3 retries, falls back to FALLBACK_MODEL on 502/503/529 |
| `tools.js` | `MANAGER_TOOLS`, `SCREENER_TOOLS`, `getToolsForRole()` — strict schema enforcement |
| `repair.js` | `parseToolArgs` — `jsonrepair` fixes malformed LLM JSON tool call arguments |
| `rate.js` | `isRateLimitError`, `rateLimitBackoff` (caps at 120s), `sleep` |
| `index.js` | Barrel re-export |

---

## Agent Roles & Tool Access

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find + deploy new positions | `deploy_position`, `get_top_candidates`, `get_token_holders`, `check_smart_wallets_on_pool` |
| `MANAGER` | Manage open positions | `close_position`, `claim_fees`, `swap_token`, `get_position_pnl`, `set_position_note` |
| `GENERAL` | Chat / manual commands | All tools (filtered by `getToolsForRole`) |

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`; if read-only, add to `READ_ONLY_CACHE`
3. **`agent/tools.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS`
4. If tool writes on-chain state, add to `WRITE_TOOLS` in executor.js

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations via `update_config` tool → updates live config + persists + restarts crons if intervals changed.

**Valid keys:**

| Key | Section | Default |
|-----|---------|---------|
| `minFeeActiveTvlRatio` | screening | 0.05 |
| `minTvl` / `maxTvl` | screening | 10k / 150k |
| `minVolume` | screening | 500 |
| `minOrganic` | screening | 60 |
| `minHolders` | screening | 500 |
| `minMcap` / `maxMcap` | screening | 150k / 10M |
| `minBinStep` / `maxBinStep` | screening | 80 / 125 |
| `timeframe` | screening | "5m" |
| `category` | screening | "trending" |
| `minTokenFeesSol` | screening | 30 |
| `maxBundlersPct` | screening | 30 |
| `maxTop10Pct` | screening | 60 |
| `blockedLaunchpads` | screening | [] |
| `deployAmountSol` | management | 0.5 |
| `maxDeployAmount` | risk | 50 |
| `maxPositions` | risk | 3 |
| `gasReserve` | management | 0.2 |
| `minSolToOpen` | management | 0.55 |
| `outOfRangeWaitMinutes` | management | 30 |
| `stopLossPct` | management | -10 |
| `takeProfitFeePct` | management | 20 |
| `trailingTakeProfit` | management | false |
| `trailingTriggerPct` / `trailingDropPct` | management | 5 / 3 |
| `managementIntervalMin` | schedule | 10 |
| `screeningIntervalMin` | schedule | 30 |
| `dailyProfitTarget` / `dailyLossLimit` | risk | 2 / -5 |
| `managementModel` / `screeningModel` / `generalModel` | llm | minimax/minimax-01 |
| `models.manager` / `screener` / `general` / `evolve` | llm | free-tier defaults |
| `cavemanEnabled` | behavior | false |
| `lpAgentRelayEnabled` | hiveMind | false |

**`computeDeployAmount(walletSol, positionCount, conviction?)`** — scales position size: `clamp(deployable × deployAmountSol, floor=deployAmountSol, ceil=maxDeployAmount)`.

**`validateAndCoerce(changes)`** (`src/core/config-validator.js`) — validates config keys before `update_config` applies them. Returns `{ valid, invalid }`. Invalid keys rejected before any apply.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `updatePnlAndCheckExits()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` → auto-swap base → Telegram notify
4. **Learn**: `evolveThresholds()` on performance data → updates config → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position`:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan)
- No duplicate `pool_address`
- No duplicate `base_mint` across pools
- `blockedLaunchpads` enforced in `getTopCandidates()`
- `maxPositionsPerToken` enforced (correlation check)
- SOL balance must cover `amount_y + gasReserve`
- If `amount_x > 0`: tokenX-only deploy (no SOL needed)

---

## Market Phases (`core/phases.js`)

```
detectMarketPhase(pool) → pump | runner | pullback | bear | consolidation | normal
```

Phase thresholds: price_change_24h, vol_ratio (volume/TVL), volatility.

`PHASE_CONFIG[phase].preferredStrategies` — strategies matched per phase via `findStrategiesForPhase()`.

---

## Token Scoring (`core/token-score.js`)

`computeTokenScore(tokenInfo, pool)` → 0-100 score with label:
- `terrible` (0–20) | `poor` (21–40) | `fair` (41–60) | `good` (61–80) | `excellent` (81–100)

Used by screener to filter candidates — prefers GOOD or EXCELLENT tokens.

---

## Pool Simulation (`core/simulator.js`)

`simulatePoolDeploy(pool, deployAmountSol, solPriceUsd)` returns:
- `daily_fees_usd`, `expected_il_usd`, `net_daily_usd`
- `risk_score` (0–100, caps at 100)
- `confidence` (0–100)
- `passes` — filter: net_daily >= min_required AND risk_score <= 40 AND confidence >= 40

Risk increases: young (<12h), high volatility, high bundle %, low organic score.
Confidence increases: older (>=48h), low volatility, high fee/TVL ratio.

## Pool Indicators (`core/pool-indicators.js`)

`fetchPoolIndicators({ pool_address, poolData, mint })` — fetches price history from Jupiter API, computes technical indicators:
- RSI (14-period)
- Bollinger Bands (20-period, 2σ)
- Supertrend (10-period ATR)
- Fibonacci retracement levels

Used by screening to enrich pool analysis. Chart indicators available as `computeRSI`, `computeBollingerBands`, `computeSupertrend`, `computeFibonacciRetracement` in `tools/chart-indicators.js`.

---

## Daily Circuit Breaker (`core/daily-tracker.js`)

`checkDailyCircuitBreaker()` → based on realized PnL from `performance` table:
- `halt` — daily loss limit hit → skip everything
- `preserve` — daily profit target hit → manage existing, no new deploys
- `trade` — normal operation

---

## bins_below Calculation (SCREENER)

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```
- volatility 0 → 35 bins
- volatility 5+ → 69 bins

---

## Lessons System

| Function | Purpose |
|----------|---------|
| `recordPerformance(closeResult)` | Called from executor after `close_position` |
| `evolveThresholds()` | Adjusts thresholds from winners vs losers; persists to config + user-config.json |
| `getRelevantLessons(context, limit)` | Tag-ranked retrieval (infers from pair, tvl, oor, pnl_pct, binStep) |
| `getLessonsForPrompt({ agentType })` | Injects lessons into system prompt |
| `getPerformanceSummary()` | Win rate, avg PnL, total closed, near-miss stats |
| `MIN_EVOLVE_POSITIONS = 5` | Minimum closed positions before evolution |

Lesson persistence: `core/lesson-repo.js` → `lessons.json`.

---

## Telegram Commands

Handled directly in `telegram-handlers.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with PnL + OOR warnings |
| `/close <n>` | Close by list index |
| `/set <n> <note>` | Set instruction on position |
| `/balance` | Wallet breakdown with USD values |
| `/briefing` | Morning briefing HTML |
| `/teach pin\|unpin\|rate\|stats\|list [role]` | Manage lessons |
| `/evolve` | Manual threshold evolution |
| `/thresholds` | Show all config thresholds + perf stats |
| `/learn` or `/learn <addr>` | Study top LPers |
| `/caveman` | Toggle prompt compression |
| `/screen` | Trigger manual screening cycle |
| `/swap-all` | Sweep all tokens to SOL |
| `/candidates` | Show top 5 candidates |
| `/status` | Combined positions + wallet status |

Free-form text → LLM chat (role: GENERAL or SCREENER if deploy intent detected).

When busy: messages queued (max 5), drained when idle.

---

## Race Condition Guards

- `_busyState._screeningBusy` — prevents concurrent screening cycles
- `_busyState._managementBusy` — prevents concurrent management cycles
- `_screeningLastTriggered` — cooldown between post-management screening triggers
- `ONCE_PER_SESSION` set in `agent/react.js` — blocks duplicate `deploy_position` / `swap_token` / `close_position` per session
- `deploy_position` safety check uses `force: true` on `getMyPositions()` for fresh count

---

## Bundler Detection (`integrations/jupiter.js` + `getTokenHolders`)

Two signals:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds:** `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)

---

## Tool Cache (`tools/executor.js`)

Read-only tools use `cachedTool()` with per-tool TTLs:

| Tool | TTL |
|------|-----|
| `get_candidates`, `discover_pools` | 5 min |
| `pool_detail`, `search_pools` | 3 min |
| `active_bin` | 1 min |
| `token_info`, `token_holders` | 10 min |
| `get_position_pnl` | 2 min |
| `get_my_positions`, `get_balances`, `get_wallet_balance` | 5 min |

Eviction every 60s. Write tools bypass cache.

---

## Caveman Mode

Toggle: `/caveman` in REPL (in-memory). Persisted via `cavemanEnabled: true` in user-config.json.

When enabled:
- System prompts compressed before LLM call (`caveman()`)
- User goals compressed before injection
- Telegram outbound messages compressed

Filler stripped: articles, hedging, pleasantries. Code blocks + JSON preserved.
`stripThink()` also removes `<truncated_thought>` blocks from LLM output.

---

## Watchdog (`watchdog.js`)

Polls open positions every 60s — no LLM unless triggered:
- `pnl_pct <= stopLossPct` → emergency close immediately (no LLM)
- `pnl_pct <= -4%` → trigger unscheduled management cycle
- Out-of-range → `markOutOfRange()` in `state/oor.js`

---

## Hive Mind (`features/hive-mind.js`)

**Experimental** — pull + push model. Enable via `config.hiveMind.url` + `config.hiveMind.apiKey`.

- `bootstrapHiveMind()` — runs on startup, generates `agentId`, pulls initial lessons
- `startHiveMindBackgroundSync()` — 15-min heartbeat, auto-pulls new lessons
- `pullHiveMindLessons()` / `pullHiveMindPresets()` — pull from collective
- `pushHiveLesson()` / `pushHivePerformanceEvent()` — push individual events
- `getSharedLessonsForPrompt({ agentType, maxLessons })` — formatted for LLM injection
- `hivemind-cache.json` — cached pulled lessons on disk

Config keys: `config.hiveMind.url`, `config.hiveMind.apiKey`, `config.hiveMind.agentId`, `config.hiveMind.pullMode`.

---

## Pool Memory (`features/pool-memory.js`)

Per-pool deploy history + snapshots. `isTokenToxic()` filter — token blocked if >66% loss rate across 3+ deploys.

---

## CLI (`cli.js`)

Standalone alternative to REPL — `kairos <subcommand>`:

| Subcommand | Description |
|------------|-------------|
| `balance` | Wallet breakdown |
| `positions` | Open positions |
| `pnl` | Closed position performance |
| `screen` | Run screening cycle |
| `manage` | Run management cycle |
| `deploy` | Deploy to a pool |
| `close` | Close a position |
| `claim` | Claim fees |
| `swap` | Swap tokens |
| `candidates` | List top candidates |
| `study [addr]` | Study top LPers |
| `token-info <addr>` | Token metadata |
| `token-holders <addr>` | Token holder analysis |
| `pool-detail <addr>` | Pool details |
| `config get\|set <key> <value>` | Read/write config |
| `lessons list\|stats` | Learning system |
| `pool-memory <addr>` | Pool deploy history |
| `evolve` | Trigger threshold evolution |
| `blacklist list\|add\|remove` | Token blacklist |
| `performance` | Full performance history |
| `start` | Start autonomous cycles |

---

## Integrations

### Helius (`integrations/helius/`)
- `balances.js` — SOL + token balances with USD conversion
- `swaps.js` — Jupiter swap execution with retry
- `auto.js` — Auto-swap fee rewards to SOL
- `normalize.js` — Balance normalization

### Meteora (`integrations/meteora/`)
- `positions.js` — Position fetching/parsing
- `pool.js` — Pool data fetching
- `close.js` — Position closing with fee claiming
- `pnl.js` — Per-position PnL calculation

### Agent Meridian Relay (`tools/agent-meridian.js`)
Centralized relay client. Routes PnL, Top-LP, and position queries through `https://api.agentmeridian.xyz/api` when `lpAgentRelayEnabled=true`. No local API key needed.

### Other
- `jupiter.js` — Token info, holders, narrative, pool search + price history for indicators
- `okx.js` — OKX exchange data for enriched pool info
- `lpagent.js` — LPAgent API: study top LPers (relayed via Agent Meridian)
- `solana.js` — Solana RPC helpers

---

## Model Configuration

- Default: `process.env.LLM_MODEL` or `minimax/minimax-01` (free-tier)
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free`
- Per-role: `models.manager`, `models.screener`, `models.general` (nested) or flat keys
- LM Studio: `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_API_KEY=lm-studio`
- `maxOutputTokens` min: 2048

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Local LLM override |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server (legacy) |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token (legacy) |
| `AGENT_MERIDIAN_API_URL` | No | Agent Meridian relay endpoint |
| `HIVE_MIND_PUBLIC_API_KEY` | No | Hive Mind public API key (experimental) |
| `LPAGENT_API_KEY` | No | LPAgent API key |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `JUPITER_DATAPI_BASE_URL` | No | Jupiter API base |
| `POOL_DISCOVERY_API_BASE` | No | Meteora pool discovery API |

---

## Node.js v24.14.1 — `_busyState` Workaround

Node.js v24.14.1 regressed ES module live bindings — imported `let` exports are read-only when imported directly. All busy flags are stored in `scheduler._busyState` object and accessed as `._managementBusy` / `._screeningBusy`. **Do not import busy flags directly as named imports and attempt to reassign them.**

---

## Known Issues / Tech Debt

- `agent.js` is a deprecated stub — all actual code moved to `agent/index.js` + `agent/react.js`
- `cli.js` completely undocumented in original CLAUDE.md despite being a full 40+ subcommand interface
