# Kairos

> **Inspired by [Meridian](https://github.com/yunus-0x/meridian)** — autonomous DLMM LP agent for Meteora pools on Solana. Screens new pairs for safety, deploys and manages liquidity positions, auto-compounds yield, and is monitored and controlled via Telegram.

---

## Prerequisites

- **Node.js** >= 18.0.0
- **Solana wallet** with SOL for gas and position funding
- **OpenRouter API key** for LLM decision-making
- **Solana RPC endpoint** (Helius recommended for production)

Optional:
- **Telegram bot token** (via [@BotFather](https://t.me/BotFather)) for monitoring and control
- **Sentry DSN** for error tracking

---

## Installation

```bash
# Navigate to the project directory
cd kairos-dllm-agent

# Install dependencies
npm install

# Copy the environment template
cp .env.example .env

# Run the interactive setup wizard (creates .env and user-config.json)
npm run setup
```

---

## Configuration

Edit `.env` with your values. Key variables:

### Required

| Variable | Description |
|----------|-------------|
| `WALLET_PRIVATE_KEY` | Solana wallet private key (base58 or JSON array format) |
| `RPC_URL` | Solana RPC endpoint (Helius recommended) |
| `LLM_API_KEY` | OpenRouter API key |

### Solana / Trading

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Set to `false` to enable on-chain transactions |
| `METEORA_COMPUTE_UNIT_LIMIT` | `1400000` | Compute unit limit for Meteora transactions |
| `METEORA_SLIPPAGE_BPS` | `1000` | Slippage in basis points (1000 = 10%) |

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `openrouter/healer-alpha` | Override default model |
| `LLM_BASE_URL` | — | Use a local LLM endpoint (e.g. LM Studio) |
| `LLM_FALLBACK_MODEL` | `stepfun/step-3.5-flash:free` | Fallback on provider 502/503/529 errors |
| `LLM_TIMEOUT_MS` | `300000` | LLM call timeout (milliseconds) |
| `MAX_WALL_CLOCK_MS` | `480` | Agent loop wall-clock timeout (seconds) |

### Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID to receive notifications and issue commands |

### External Services

| Variable | Description |
|----------|-------------|
| `HELIUS_API_KEY` | Helius API key for enriched wallet/portfolio data |
| `JUPITER_API_KEY` | Jupiter API key for token audit pipeline |
| `LPAGENT_API_KEY` | LPAgent API key for studying top LPers |
| `HIVE_MIND_URL` | Optional collective intelligence server URL |
| `HIVE_MIND_API_KEY` | Hive Mind auth token |
| `SENTRY_DSN` | Sentry error tracking DSN (leave empty to disable) |

### Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `CAVEMAN_ENABLED` | `false` | Enable prompt compression to reduce token usage |
| `HEALTH_PORT` | `3030` | Port for the health check endpoint |

---

## Running

### Development (dry run — no real transactions)

```bash
npm run dev
# or
DRY_RUN=true node src/index.js
```

### Production

```bash
# Confirm DRY_RUN=false in .env before running

# Start with PM2 (recommended)
pm2 start ecosystem.config.js --name kairos

# View logs
pm2 logs kairos

# Restart
pm2 restart kairos

# Auto-start on boot
pm2 save
pm2 startup
```

### Direct (without PM2)

```bash
node src/index.js
```

---

## Monitoring

### Health endpoint

```bash
curl http://localhost:3030/health
```

Returns JSON with uptime, memory usage, and last management cycle timestamp.

### Telegram commands

Start a chat with your bot and send:

| Command | Description |
|---------|-------------|
| `/balance` | Show wallet SOL and token balances |
| `/positions` | List all open positions with PnL |
| `/close <n>` | Close position by its list number |
| `/set <n> <note>` | Attach an instruction to a position |
| `/briefing` | Daily morning briefing (HTML) |
| `/thresholds` | Show current screening thresholds and performance stats |
| `/candidates` | Refresh and display top pool candidates |
| `/learn` | Study top LPers via LPAgent |
| `/evolve` | Manually trigger threshold evolution |
| `/caveman` | Toggle prompt compression mode |
| `/teach pin\|unpin <id>` | Pin or unpin a lesson |

### REPL commands (when running interactively)

| Command | Description |
|---------|-------------|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen top pool candidates |
| `/learn` | Study top LPers |
| `/thresholds` | Current screening thresholds and performance |
| `/evolve` | Trigger threshold evolution |
| `/stop` | Graceful shutdown |

---

## Troubleshooting

### Bot not responding to Telegram
- Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`
- Make sure the bot has been started — send `/start` to it in Telegram

### Positions not deploying
- Confirm `DRY_RUN=false` in `.env`
- Check your SOL balance via `/balance`
- Verify `RPC_URL` is accessible and not rate-limited

### Screener finds no pools
- Check RPC has sufficient rate limit capacity
- Thresholds in `user-config.json` may be too restrictive — run `/thresholds` to review

### High memory usage
- PM2 `max_memory_restart` is set to 512MB by default
- Prune old log files in `logs/`
- Prune old backups in `backups/`

### Database recovery
```bash
# Restore from a backup
cp backups/kairos-YYYY-MM-DD.db src/core/kairos.db

# Restart
pm2 restart kairos
```

---

## Upgrading

```bash
git pull
npm install
pm2 restart kairos
```

---

## Available Scripts

| Script | Purpose |
|--------|---------|
| `npm run setup` | Initial setup |
| `npm start` | Start the agent |
| `npm run dev` | Start in dry-run mode |
| `npm test` | Run tests |
| `npm run test:screen` | Test screening flow |
| `npm run test:agent` | Test agent loop |
