# KAIROS

> **Autonomous DLMM LP agent** for Meteora pools on Solana. Screens, deploys, and manages liquidity positions automatically. Controlled via Telegram or CLI.

[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/meridian-agents/kairos-dllm-agent)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://github.com/meridian-agents/kairos-dllm-agent/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17.0-brightgreen?logo=node.js&logoColor=339933&style=flat-square)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-14f195?logo=solana&logoColor=14F195&style=flat-square)](https://solana.com)
[![Meteora](https://img.shields.io/badge/Meteora-7c3aed?style=flat-square)](https://meteora.ag)
[![Helius](https://img.shields.io/badge/Helius-orange?style=flat-square)](https://helius.xyz)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-c0242f?logo=openai&logoColor=00ACF7&style=flat-square)](https://openrouter.ai)
[![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?logo=telegram&logoColor=2CA5E0&style=flat-square)](https://core.telegram.org)
[![Status](https://img.shields.io/badge/autonomous-brightgreen?style=flat-square)]()

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
cd kairos-dllm-agent
npm install
cp .env.example .env
npm run setup   # interactive wizard — creates .env and user-config.json
```

---

## Configuration

### `.env` — environment variables

#### Required

| Variable | Description |
|----------|-------------|
| `WALLET_PRIVATE_KEY` | Solana wallet private key (base58 or JSON array format) |
| `RPC_URL` | Solana RPC endpoint (Helius recommended) |
| `OPENROUTER_API_KEY` | OpenRouter API key |

#### Trading

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | — | Set to `true` to simulate (no on-chain transactions) |
| `METEORA_COMPUTE_UNIT_LIMIT` | `1400000` | Compute unit limit for Meteora transactions |
| `METEORA_SLIPPAGE_BPS` | `1000` | Slippage in basis points (1000 = 10%) |

#### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `minimax/minimax-01` | Override default model |
| `LLM_BASE_URL` | — | Use a local LLM endpoint (e.g. LM Studio at `http://localhost:1234/v1`) |
| `LLM_API_KEY` | `openai` | Needed for local endpoints; `OPENROUTER_API_KEY` for OpenRouter |
| `LLM_FALLBACK_MODEL` | `stepfun/step-3.5-flash:free` | Fallback on provider 502/503/529 errors |

#### Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID to receive notifications and issue commands |

#### External Services

| Variable | Description |
|----------|-------------|
| `HELIUS_API_KEY` | Helius API key for enriched wallet/portfolio data |
| `JUPITER_DATAPI_BASE_URL` | Jupiter API base (auto-detected if not set) |
| `POOL_DISCOVERY_API_BASE` | Meteora pool discovery API base |
| `LPAGENT_API_KEY` | LPAgent API key for studying top LPers |

#### Agent Meridian / Hive Mind (experimental)

| Variable | Description |
|----------|-------------|
| `AGENT_MERIDIAN_API_URL` | Agent Meridian relay endpoint (e.g. `https://api.agentmeridian.xyz/api`) |
| `HIVE_MIND_PUBLIC_API_KEY` | Hive Mind public API key |
| `lpAgentRelayEnabled` | Enable Agent Meridian relay for PnL/positions (set in `user-config.json`, not `.env`) |

#### Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `CAVEMAN_ENABLED` | `false` | Enable prompt compression (reduces token usage) |
| `HEALTH_PORT` | `3030` | Port for the health check endpoint |
| `SENTRY_DSN` | — | Sentry error tracking DSN (leave empty to disable) |

### `user-config.json` — runtime thresholds

Runtime-configurable via `/set` Telegram command or `update_config` tool. Persists across restarts. Key sections:

| Section | Notable keys |
|---------|--------------|
| `screening` | `minTvl`, `maxTvl`, `minVolume`, `minOrganic`, `minBinStep`/`maxBinStep`, `timeframe`, `category` |
| `management` | `deployAmountSol`, `stopLossPct`, `trailingTakeProfit`, `outOfRangeWaitMinutes`, `minClaimAmount` |
| `risk` | `maxPositions`, `maxDeployAmount`, `dailyProfitTarget`, `dailyLossLimit` |
| `schedule` | `managementIntervalMin`, `screeningIntervalMin` |
| `llm` | `models.manager`, `models.screener`, `models.general` |

**`validateAndCoerce(changes)`** — all config changes are validated before apply. Invalid keys are rejected outright.

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
RSI, Bollinger Bands, Supertrend, Fibonacci retracement levels from Jupiter price history. Available via `computeRSI`, `computeBollingerBands`, `computeSupertrend`, `computeFibonacciRetracement` tools.

### Hive Mind — Experimental
Collective intelligence via Agent Meridian relay. Pulls shared lessons from other agents. Pushes individual performance events. 15-min background sync + startup bootstrap. Enable via `config.hiveMind.url` + `config.hiveMind.apiKey` in `user-config.json`.

### Lessons System
- Records every closed position's outcome
- Tag-ranked retrieval (infers from pair, tvl, oor, pnl_pct, binStep)
- Threshold evolution: adjusts screening/management config from win/loss patterns
- Minimum 5 closed positions before auto-evolution

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
kairos balance          # Wallet breakdown
kairos positions        # Open positions
kairos pnl              # Closed position performance
kairos screen           # Run screening cycle
kairos manage           # Run management cycle
kairos candidates       # List top candidates
kairos pool-detail <addr>  # Pool details
kairos config get <key>    # Read config
kairos config set <key> <val>  # Write config
kairos lessons list|stats  # Learning system
kairos evolve           # Trigger threshold evolution
kairos blacklist list|add|remove  # Token blacklist
kairos performance      # Full performance history
kairos start            # Start autonomous cycles
```
