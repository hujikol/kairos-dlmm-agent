# Meridian — CLAUDE.md

Autonomous DLMM LP agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (MAX_REACT_DEPTH=6, MAX_TOOL_CALLS_PER_STEP=10): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per role (SCREENER/MANAGER/GENERAL); compressPositions() for compact context
state.js            Position registry via SQLite
lessons.js          Learning engine: recordPerformance, evolveThresholds, getRelevantLessons + inferTags
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications; caveman() applied to outbound
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
logger.js           Daily-rotating log files + action audit trail
watchdog.js         60s polling for emergency loss conditions — emergency close without LLM

tools/
  definitions.js    Tool schemas in OpenAI format
  executor.js       Tool dispatch: name → fn, safety checks, READ_ONLY_CACHE for cached tools
  cache.js          Unified TTL cache (60s eviction)
  caveman.js        Filler stripper for prompt compression; CAVEMAN_ENABLED toggle
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three roles filter which tools LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find + deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:7-8`. If you add a tool, add it to the relevant sets.

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`; if read-only, add to `READ_ONLY_CACHE`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If tool writes on-chain state, add to `WRITE_TOOLS` in executor.js

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool which updates live config + persists to `user-config.json` + restarts crons if intervals changed.

**Valid keys:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | minimax/minimax-01 |
| models.manager / screener / general / evolve | llm | free-tier defaults |
| cavemanEnabled | behavior | false |

**`computeDeployAmount(walletSol)`** — scales position size: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base → Telegram notify
4. **Learn**: `evolveThresholds()` on performance data → updates config → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position`:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan)
- No duplicate pool_address
- No duplicate base_mint across pools
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```
- volatility 0 → 35 bins
- volatility 5+ → 69 bins

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions |
| `/close <n>` | Close by list index |
| `/set <n> <note>` | Set instruction on position |
| `/balance` | Wallet breakdown |
| `/briefing` | Morning briefing HTML |
| `/teach pin\|unpin <id>` | Pin/unpin lessons |
| `/evolve` | Manual threshold evolution |
| `/thresholds` | Show thresholds + perf stats |
| `/learn` or `/learn <addr>` | Study top LPers |
| `/caveman` | Toggle prompt compression |

Progress bar: `[████████░░░░░░░░░░░░] 40%`

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. `deploy_position` safety check uses `force: true` on `getMyPositions()` for fresh count.

---

## Bundler Detection (token.js)

Two signals in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds:** `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` 5–25% normal for legitimate tokens.

---

## Base Fee Calculation (dlmm.js)

```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default: `process.env.LLM_MODEL` or `minimax/minimax-01` (free-tier)
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free`
- Per-role: `models.manager`, `models.screener`, `models.general` (nested) or flat keys
- LM Studio: `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_API_KEY=lm-studio`
- `maxOutputTokens` min: 2048

---

## Lessons System

`lessons.js` records closed position performance + auto-derives lessons:
- `getLessonsForPrompt({ agentType })` — inject lessons into system prompt
- `getRelevantLessons(context, limit)` — tag-ranked retrieval (infers from pair, tvl, oor, pnl_pct, binStep)
- `evolveThresholds()` — adjusts thresholds from winners vs losers; persists ALL changed keys to config + user-config.json
- `recordPerformance()` — called from executor.js after `close_position`
- `MIN_EVOLVE_POSITIONS = 5`

---

## Tool Cache (executor.js)

Read-only tools use `cachedTool()` with per-tool TTLs:

| Tool | TTL |
|------|-----|
| get_candidates, discover_pools | 5 min |
| pool_detail, search_pools | 3 min |
| active_bin | 1 min |
| token_info, token_holders | 10 min |
| get_position_pnl | 2 min |
| get_my_positions, get_balances, get_wallet_balance | 5 min |

Eviction every 60s. Write tools bypass cache.

---

## Caveman Mode

Toggle: `/caveman` in REPL (in-memory). Persisted via `cavemanEnabled: true` in user-config.json.

When enabled:
- System prompts compressed before LLM call
- User goals compressed before injection
- Telegram outbound messages compressed

Filler stripped: articles, hedging, "please note that", "I would recommend", etc. Code blocks + JSON preserved.

---

## Watchdog (watchdog.js)

Polls open positions every 60s — no LLM unless triggered:
- `pnl_pct <= stopLossPct` → emergency close immediately (no LLM)
- `pnl_pct <= -4%` → trigger unscheduled management cycle
- Out-of-range → update `oor_since` timestamp

Started automatically via `launchCron()`.

---

## Hive Mind (hive-mind.js)

Optional. Enable: `HIVE_MIND_URL` + `HIVE_MIND_API_KEY` in `.env`. Syncs lessons/deploys to shared server, queries consensus patterns.

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
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

All Phase 1 correctness bugs resolved. Remaining:
- Caveman mode persisted via user-config.json; startup reads `cavemanEnabled` automatically.
