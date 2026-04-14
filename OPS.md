# Meridian — Operations Guide

## Quick Start

```bash
# Development
node src/index.js

# Production (PM2)
pm2 start ecosystem.config.js --name meridian
pm2 monit
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `WALLET_PRIVATE_KEY` | Yes | — | Base58 or JSON array |
| `RPC_URL` | Yes | — | Solana RPC endpoint |
| `SENTRY_DSN` | No | — | Sentry error tracking DSN |
| `LLM_API_KEY` | Yes | — | OpenRouter API key |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | — | Telegram notification target |
| `LLM_BASE_URL` | No | — | Local LLM override |
| `LLM_MODEL` | No | `openrouter/healer-alpha` | Override default model |
| `LLM_FALLBACK_MODEL` | No | `stepfun/step-3.5-flash:free` | Fallback on provider errors |
| `LLM_TIMEOUT_MS` | No | `300000` | LLM call timeout |
| `MAX_WALL_CLOCK_MS` | No | `480000` | Agent loop wall-clock timeout |
| `DRY_RUN` | No | — | Skip on-chain transactions |
| `HIVE_MIND_URL` | No | — | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | — | Hive mind auth token |
| `HELIUS_API_KEY` | No | — | Enhanced wallet data |
| `HELIUS_API_BASE` | No | `https://api.helius.xyz` | Helius API base |
| `JUPITER_API_KEY` | No | — | Jupiter API key |
| `JUPITER_DATAPI_BASE_URL` | No | `https://datapi.jup.ag/v1` | Jupiter datapi base |
| `JUPITER_PRICE_API_URL` | No | `https://api.jup.ag/price/v3` | Jupiter price API |
| `JUPITER_ULTRA_API_URL` | No | `https://api.jup.ag/ultra/v1` | Jupiter ultra API |
| `JUPITER_QUOTE_API_URL` | No | `https://api.jup.ag/swap/v1` | Jupiter quote API |
| `LPAGENT_API_KEY` | No | — | Top LPer study via LPAgent |
| `LPAGENT_API_BASE` | No | `https://api.lpagent.io/open-api/v1` | LPAgent API base |
| `LPAGENT_RATE_LIMIT_BUFFER_MS` | No | `1000` | Rate limit window buffer |
| `POOL_DISCOVERY_API_BASE` | No | `https://pool-discovery-api.datapi.meteora.ag` | Meteora pool discovery |
| `METEORA_DLMM_API_BASE` | No | `https://dlmm.datapi.meteora.ag` | Meteora DLMM API |
| `METEORA_COMPUTE_UNIT_LIMIT` | No | `1400000` | Compute unit limit for txs |
| `METEORA_SLIPPAGE_BPS` | No | `1000` | Slippage in basis points (1000=10%) |
| `METEORA_POSITIONS_CACHE_TTL_MS` | No | `300000` | Positions cache TTL (5 min) |
| `METEORA_CLOSE_SYNC_WAIT_MS` | No | `5000` | Wait after close before verifying |
| `METEORA_CLOSE_RETRY_DELAY_MS` | No | `3000` | Close verification retry delay |
| `OKX_API_BASE` | No | `https://web3.okx.com` | OKX API base |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenRouter base |
| `MINIMAX_BASE_URL` | No | `https://api.minimax.io/v1` | MiniMax base |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base |
| `LOCAL_LLM_BASE_URL` | No | `http://localhost:1234/v1` | Local LLM (LM Studio/Ollama) |
| `SOLANA_BACKOFF_BASE_DELAY_MS` | No | `1000` | RPC rate-limit backoff base |
| `SOLANA_BACKOFF_MAX_DELAY_MS` | No | `30000` | RPC backoff max delay |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | No | `text` | `text` or `json` |
| `LOG_MAX_SIZE` | No | `10000000` | Bytes per log file before rotation |
| `LOG_MAX_FILES` | No | `7` | Number of rotated log files to keep |
| `HEALTH_PORT` | No | `3030` | Health endpoint port |
| `TELEGRAM_MSG_DELAY_MS` | No | `1500` | Delay between Telegram messages |
| `TELEGRAM_POLL_TIMEOUT_MS` | No | `35000` | Telegram long-poll timeout |
| `BRIEFING_LOOKBACK_MS` | No | `86400000` | Briefing lookback window (24h) |
| `HIVE_MIND_SYNC_DEBOUNCE_MS` | No | `300000` | Hive Mind sync debounce (5 min) |
| `HIVE_MIND_GET_TIMEOUT_MS` | No | `5000` | Hive Mind GET timeout |
| `HIVE_MIND_POST_TIMEOUT_MS` | No | `10000` | Hive Mind POST timeout |
| `HELIUS_BALANCE_CACHE_TTL_MS` | No | `300000` | Helius balance cache TTL |
| `WATCHDOG_POLL_INTERVAL_MS` | No | `60000` | Watchdog poll interval (1 min) |
| `CAVEMAN_ENABLED` | No | `false` | Enable prompt compression |

## Process Management (PM2)

```bash
# Start
pm2 start ecosystem.config.js --name meridian

# View logs
pm2 logs meridian

# Restart
pm2 restart meridian

# Stop
pm2 stop meridian

# Auto-start on boot
pm2 save
pm2 startup  # run once after install, copies init script
```

## Health Check

```bash
curl http://localhost:3030/health
# Returns: ok
```

## Database Backup

```bash
# Manual
node scripts/backup-db.js

# Dry run first
node scripts/backup-db.js --dry-run

# Automated — add to crontab:
# 0 3 * * * cd /path/to/meridian && node scripts/backup-db.js >> logs/backup.log 2>&1
```

Backups stored in `backups/meridian-YYYY-MM-DD.db`. Script keeps last 7.

## Log Rotation

Logs rotate automatically when file exceeds 10MB. Keeping 7 rotated files per type.

| File | Contents |
|------|----------|
| `logs/agent-YYYY-MM-DD.log` | All log levels |
| `logs/errors-YYYY-MM-DD.log` | Error-level only |

## Updating

```bash
# Pull latest
git pull

# Update dependencies
npm install

# Restart
pm2 restart meridian
```

## Panic Recovery

If the bot goes sideways:

```bash
# Check what's running
pm2 list

# Force restart
pm2 restart meridian --update-env

# View last errors
pm2 logs meridian --err --lines 50

# If DB is corrupted:
#   cp backups/meridian-YYYY-MM-DD.db src/core/meridian.db
```

## Key Files

| Path | Purpose |
|------|---------|
| `src/index.js` | Main entry, cron orchestration, REPL |
| `src/core/lessons.js` | Learning system |
| `src/core/threshold-evolver.js` | Threshold evolution algorithm |
| `src/core/state.js` | SQLite position registry |
| `src/core/db.js` | Database connection |
| `src/core/logger.js` | Log rotation |
| `src/integrations/meteora.js` | DLMM pool interactions |
| `src/integrations/helius.js` | Wallet balances, swaps |
| `src/screening/discovery.js` | Pool discovery |
| `src/agent.js` | ReAct agent loop |
| `src/tools/executor.js` | Tool dispatch |
| `src/watchdog.js` | Emergency close polling |
| `src/notifications/telegram.js` | Telegram bot |
| `src/notifications/queue.js` | Notification queue |
| `scripts/backup-db.js` | Database backup |

## Troubleshooting

**Bot not responding to Telegram:**
- Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set
- Verify bot has been started (/start in Telegram)

**Positions not deploying:**
- Check `RPC_URL` is accessible
- Check SOL balance: `/balance` in Telegram
- Check `DRY_RUN` is not set

**Screener finds no pools:**
- Check RPC has sufficient rate limit capacity
- Check `user-config.json` thresholds aren't too restrictive
- Run `/thresholds` in Telegram to see current config

**High memory usage:**
- PM2 max_memory_restart set to 512MB
- Logs in `logs/` — rotate or prune old files
- `backups/` directory — prune backups older than 7 days

## Discord LP Army Listener (DEPRECATED/REMOVED)

The Discord listener using `discord.js-selfbot-v13` has been **removed**.

**Why removed:** Selfbots violate Discord Terms of Service. The `discord.js-selfbot-v13`
package is unmaintained and Discord periodically revokes selfbot tokens without warning.

**Migration path:** If you want to re-implement LP Army signal ingestion, use a proper
Discord bot account with a bot token (not a user token). See the archived
`discord-listener/README.md` pattern documented elsewhere, or use Discord webhooks.

**DISCORD_USER_TOKEN** — No longer used. Remove from `.env` if present.
