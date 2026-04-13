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
| `OPENROUTER_API_KEY` | Yes | — | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | — | Telegram notification target |
| `LLM_BASE_URL` | No | — | Local LLM override |
| `LLM_MODEL` | No | `minimax/minimax-01` | Override default model |
| `DRY_RUN` | No | — | Skip on-chain transactions |
| `HIVE_MIND_URL` | No | — | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | — | Hive mind auth token |
| `HELIUS_API_KEY` | No | — | Enhanced wallet data |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | No | `text` | `text` or `json` |
| `LOG_MAX_SIZE` | No | `10000000` | Bytes per log file before rotation |
| `LOG_MAX_FILES` | No | `7` | Number of rotated log files to keep |
| `HEALTH_PORT` | No | `3030` | Health endpoint port |
| `METEORA_CLOSE_SYNC_WAIT_MS` | No | `5000` | Wait after close before verifying |
| `METEORA_CLOSE_RETRY_DELAY_MS` | No | `3000` | Delay between close verification retries |
| `SENTRY_DSN` | No | — | Sentry error tracking DSN |
| `METEORA_POSITIONS_CACHE_TTL_MS` | No | `300000` | Positions cache TTL |

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
|------|---------|
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
