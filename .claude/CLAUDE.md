# Kairos — CLAUDE.md

Autonomous DLMM LP agent for Meteora pools on Solana. Forked from Meridian.

---

## Quick Reference

```
src/
├── agent/          ReAct loop (intent, fallback, rate-limit, JSON repair)
├── cli/            CLI command modules (25 commands, see §CLI)
├── core/           Engine: cycles, scheduler, state, learning, strategies
│   └── state/      scheduler-state, registry, OOR, PnL, events, sync
├── features/       Pool memory, hive-mind, smart-wallets, blacklists
├── integrations/   Helius, Jupiter (OKX cache), Meteora, OKX, LPAgent, Solana
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
| `cli.js` | Standalone CLI (`kairos <subcommand>`) — dispatcher, delegates to `src/cli/commands/` |
| `src/cli/commands/` | 25 command modules (balance, positions, screen, deploy, etc.) |
| `repl.js` | REPL line handler: number-pick deploy, slash commands |
| `watchdog.js` | 60s polling for emergency loss → triggers management cycle directly |
| `telegram-handlers.js` | Telegram bot: 14 commands + free-form LLM chat |
| `setup.js` | Interactive first-run wizard |

---

## Core Cycle System

**`cycles.js`** is canonical — all runtime entry points import from here:
- `scheduler.js` — cron triggers (`startCronJobs` / `stopCronJobs`)
- `watchdog.js` — emergency polling
- `index.js` — main entry
- `telegram-handlers.js` — imports from `cycles.js`

**`_busyState` and `_timersState`** live in `src/core/state/scheduler-state.js` — extracted to break circular import cycles. Import from there, not directly from scheduler.js.

### `runManagementCycle()`
- Fetches positions + balances
- Deterministic rule engine → action map (CLOSE/CLAIM/STAY/INSTRUCTION)
- JS trailing TP check via `updatePnlAndCheckExits`
- Calls LLM only if action needed (role: MANAGER)
- Post-trade: `autoSwapAndNotify()` → auto-swap fee tokens to SOL
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
| `scheduler-state.js` | `_busyState`, `_timersState` — extracted to break circular deps |
| `registry.js` | Position CRUD: `trackPosition`, `updatePositionStatus`, `recordClose`, `recordRebalance`, `recordClaim`, `setPositionInstruction`, `getStateSummary` |
| `oor.js` | OOR single source of truth: `markOutOfRange`, `markInRange`, `minutesOutOfRange` |
| `pnl.js` | `updatePnlAndCheckExits` — peak_pnl, volatility-adaptive trailing TP, 4 exit signals |
| `events.js` | Event log: `pushEvent`, `getRecentEvents` |
| `sync.js` | `syncOpenPositions` — on-chain state reconciliation |

---

## Shared Handlers (`src/core/shared-handlers.js`)

Business logic extracted for both REPL and Telegram — platform formatters stay in their respective files.

| Function | Returns |
|----------|---------|
| `getStatusData()` | `{ wallet, positions, total_positions }` |
| `getBalanceData()` | `{ sol, sol_usd, tokens, total_usd }` |
| `getCandidatesData({ limit })` | `{ candidates, total_eligible, total_screened }` |
| `getThresholdsData()` | `{ screening: {...}, management: {...}, performance }` |
| `getPositionsData()` | `{ positions, total_positions }` |
| `triggerScreen()` | fires `runScreeningCycle()`, returns `{ triggered: true }` |
| `getSwapAllResult()` | raw `swapAllTokensToSol()` result |
| `getBriefingData()` | raw briefing data object |

---

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
| `MANAGER` | Manage open positions | `close_position`, `claim_fees`, `swap_token`, `update_config`, `get_position_pnl`, `get_my_positions`, `set_position_note` |
| `GENERAL` | Chat / manual commands | All tools (filtered by `getToolsForRole`) |

**Pool discovery tools (use exact names):** `discover_pools`, `search_pools`, `get_pool_detail`, `get_top_lpers`, `study_top_lpers`, `get_active_bin`, `get_pool_memory`. Never invent tool names.

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`; if read-only, add to `READ_ONLY_CACHE`
3. **`agent/tools.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS`
4. If tool writes on-chain state, add to `WRITE_TOOLS` in executor.js

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations via `update_config` tool → updates live config + persists + restarts crons if intervals changed.

**v1 → v2 migration:** Flat keys in `user-config.json` are automatically wrapped under their section (`screening`, `management`, `risk`, etc.).

**Conviction Sizing Matrix:**

| Positions | Conviction | Amount |
|-----------|------------|--------|
| 0 | very_high | 1.50 SOL |
| 1+ | very_high | 1.00 SOL |
| any | high | 1.00 SOL |
| any | normal | 0.50 SOL |

`computeDeployAmount(walletSol, openPositions, conviction)` — clamped to `gasReserve` and `maxDeployAmount`.

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
- `bid_ask` strategy: `bins_above` must be 0 (rejects if > 0, forces `amount_x = 0`)
- `amount_x > 1e11`: rejected as LLM hallucination

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

---

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

## Telegram Commands (`telegram-handlers.js`)

`telegramHandler` is a dispatcher — exact-match `switch` for commands, regex for indexed/set commands, LLM fallback. Each handler is a named function at module scope.

`safeSend(chatId, text)` helper DRYs up error handling across all handlers.

| Command | Handler | Action |
|---------|---------|--------|
| `/briefing` | `handleBriefing()` | Morning briefing HTML |
| `/balance` | `handleBalance()` | Wallet breakdown with USD values |
| `/status` | `handleStatus()` | Combined positions + wallet status |
| `/candidates` | `handleCandidates()` | Top 5 candidates table |
| `/screen` | `handleScreen()` | Manual screening cycle |
| `/swap-all` | `handleSwapAll()` | Sweep all tokens to SOL |
| `/thresholds` | `handleThresholds()` | Config thresholds + perf stats |
| `/positions` | `handlePositions()` | Open positions table |
| `/close <n>` | `handleClose(text)` | Close by list index |
| `/set <n> <note>` | `handleSet(text)` | Set instruction on position |
| `/teach <sub>` | `handleTeach(text)` | pin\|unpin\|rate\|stats\|list lessons |
| `/caveman` | `handleCaveman()` | Toggle prompt compression |
| `/learn [addr]` | `handleLLMChat()` | Study top LPers (LLM) |
| free-form | `handleLLMChat()` | LLM chat (role: GENERAL or SCREENER) |

When busy: messages queued (max 5), drained when idle.

---

## REPL Commands (`repl.js`)

Delegates to `src/core/shared-handlers.js` for: `/status`, `/balance`, `/candidates`, `/thresholds`, `/screen`, `/swap-all`. Other commands use inline logic.

---

## Race Condition Guards

- `_busyState._screeningBusy` — prevents concurrent screening cycles
- `_busyState._managementBusy` — prevents concurrent management cycles
- `_timersState.screeningLastTriggered` — cooldown between post-management screening triggers
- `ONCE_PER_SESSION` set in `agent/react.js` — blocks duplicate `deploy_position` / `swap_token` / `close_position` per session
- `deploy_position` safety check uses `force: true` on `getMyPositions()` for fresh count

---

## Bundler Detection (`integrations/jupiter.js` + `getTokenHolders`)

Two signals:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds:** `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)

**OKX Enrichment Cache** (`jupiter.js`): `okxEnrichmentCache` Map with 5-min TTL. `getTokenInfo()` and `getTokenHolders()` share a single OKX fetch per token per pass (was 4 calls → 2).

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

## CLI (`src/cli/`)

`cli.js` is a ~300-line dispatcher. All subcommand logic lives in `src/cli/commands/`.

```
cli.js              ← dispatcher (parses args, registers command map)
cli/utils.js       ← shared utilities (DRY_RUN, out, die, .env loading)
cli/commands/      ← 25 command modules (static imports)
```

| Subcommand | File |
|------------|------|
| `balance` | `balance.js` |
| `positions` | `positions.js` |
| `pnl` | `pnl.js` |
| `screen` | `screen.js` |
| `manage` | `manage.js` |
| `deploy` | `deploy.js` |
| `close` | `close.js` |
| `claim` | `claim.js` |
| `swap` | `swap.js` |
| `candidates` | `candidates.js` |
| `study` | `study.js` |
| `token-info` | `token-info.js` |
| `token-holders` | `token-holders.js` |
| `token-narrative` | `token-narrative.js` |
| `pool-detail` | `pool-detail.js` |
| `search-pools` | `search-pools.js` |
| `active-bin` | `active-bin.js` |
| `wallet-positions` | `wallet-positions.js` |
| `config` | `config.js` |
| `lessons` | `lessons.js` |
| `pool-memory` | `pool-memory.js` |
| `evolve` | `evolve.js` |
| `blacklist` | `blacklist.js` |
| `performance` | `performance.js` |
| `start` | `start.js` |

Each module exports `async function cmd(argv, flags, sub2, silent)`.

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
- `close.js` — Position closing with fee claiming + on-chain lag resilience (fees preserved if closed-API returns empty)
- `pnl.js` — Per-position PnL calculation

### Jupiter (`integrations/jupiter.js`)
- Token info, holders, narrative, pool search + price history
- Shared OKX enrichment cache (5-min TTL, eliminates redundant OKX calls)

### Agent Meridian Relay (`tools/agent-meridian.js`)
Centralized relay client. Routes PnL, Top-LP, and position queries through `https://api.agentmeridian.xyz/api` when `lpAgentRelayEnabled=true`. No local API key needed.

### Other
- `okx.js` — OKX exchange data for enriched pool info
- `lpagent.js` — LPAgent API: study top LPers (relayed via Agent Meridian)
- `solana.js` — Solana RPC helpers

---

## Model Configuration

- Default: `process.env.LLM_MODEL` or `minimax/minimax-01`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free`
- Per-role: `models.manager`, `models.screener`, `models.general`, `models.evolve` (nested) or flat keys
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
| `AGENT_MERIDIAN_API_URL` | No | Agent Meridian relay endpoint |
| `HIVE_MIND_PUBLIC_API_KEY` | No | Hive Mind public API key (experimental) |
| `LPAGENT_API_KEY` | No | LPAgent API key |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `JUPITER_DATAPI_BASE_URL` | No | Jupiter API base |
| `POOL_DISCOVERY_API_BASE` | No | Meteora pool discovery API |

---

## Node.js v24.14.1 — `_busyState`

Node.js v24.14.1 regressed ES module live bindings — imported `let` exports are read-only when imported directly. Busy flags live in `src/core/state/scheduler-state.js` and are accessed as `scheduler-state._busyState._managementBusy` / `._screeningBusy`. **Do not import busy flags as named `let` exports and reassign them.**

---

## CI — Run Before Every Commit

**All commits must pass lint and syntax checks locally before pushing.**

**Strict rule: unused variables and imports must be removed or prefixed with `_`.**
Do not leave `argv`, `flags`, `log`, `config`, `db`, etc. unused. Prefix genuinely
unneeded params with `_` (e.g., `function foo(_arg)`). Prefix unused imports with
`_` (e.g., `import { foo as _foo }`). This keeps lint warnings at zero.

```bash
npm run lint      # ESLint — must show 0 errors (warnings OK)
npm test          # Unit tests — must pass
node --check src/index.js src/agent/index.js src/core/db.js src/core/logger.js src/core/scheduler.js src/integrations/meteora.js src/integrations/helius.js src/core/postmortem.js src/core/simulator.js  # All must exit 0
WALLET_PRIVATE_KEY="[]" RPC_URL="https://api.mainnet-beta.solana.com" OPENROUTER_API_KEY="test-key" node --test test/debug_insert.js test/helius-cache.js test/mem-db.js test/notifications.js test/postmortem-signalweights.js test/screening-api.js  # Integration tests — all must pass
```

CI pipeline (`.github/workflows/ci.yml`):
1. `npm audit --audit-level=high` — security audit, blocks on high+ vulnerabilities
2. `npm run lint` — ESLint, blocks on any lint error
3. `npm test` — Node.js test runner, blocks on test failures
4. Integration tests — `node --test` on `test/*.js` (non `test-*.js` / `*.test.js` files)
5. Syntax check — `node --check` on 8 core entry files

**CI does not require real API keys.** All jobs use mock env vars (`WALLET_PRIVATE_KEY="[]"`, `RPC_URL="https://api.mainnet-beta.solana.com"`, `OPENROUTER_API_KEY="test-key"`).

## Infrastructure

- **Linting:** ESLint (`.eslintrc.json`) — `npm run lint`
- **Formatting:** Prettier (`.prettierrc.json`) — `npm run format`
- **Dependency updates:** Dependabot (`.github/dependabot.yml`) — automated PRs for npm packages
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) — see §CI
- **SQLite DB:** `*.db` files in `.gitignore` — never commit wallet/position data

---

## Deprecated / Removed

- `agent.js` (root) — deprecated stub, all code moved to `agent/index.js` + `agent/react.js`
- `db.js`, `logger.js` (root) — deleted, all imports redirected to `src/core/`
- `test/test-management-cycle.mjs` — deleted, consolidated to `test/test-management-cycle.js`
- `CONFIG_MAP` dead export in `config-validator.js` — removed
