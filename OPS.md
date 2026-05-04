# Meridian — Operations Guide

## Quick Start

```bash
# Development
node src/index.js

# Production (PM2)
pm2 start ecosystem.config.js --name kairos
pm2 monit
```

## Environment Variables

> **Note:** `OPENROUTER_API_KEY` is the primary key for OpenRouter. Code also accepts `LLM_API_KEY` for local LLM endpoints.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `WALLET_PRIVATE_KEY` | Yes | — | Base58 or JSON array |
| `RPC_URL` | Yes | — | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | — | Primary OpenRouter API key (also accepts `LLM_API_KEY` for local endpoints) |
| `DRY_RUN` | No | — | Skip on-chain transactions |
| `LLM_MODEL` | No | `MiniMax-M2.7` | Override default model |
| `LLM_BASE_URL` | No | — | Local LLM endpoint (e.g. LM Studio `http://localhost:1234/v1`) |
| `LLM_API_KEY` | No | — | API key for local endpoints; fallback for `OPENROUTER_API_KEY` |
| `LLM_FALLBACK_MODEL` | No | `stepfun/step-3.5-flash:free` | Fallback on provider 502/503/529 errors |
| `LLM_TIMEOUT_MS` | No | `300000` | LLM call timeout (5 min) |
| `MAX_WALL_CLOCK_MS` | No | `480000` | Agent loop wall-clock timeout (8 min) |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | — | Telegram notification target |
| `TELEGRAM_MSG_DELAY_MS` | No | `1500` | Delay between Telegram messages |
| `TELEGRAM_POLL_TIMEOUT_MS` | No | `35000` | Telegram long-poll timeout |
| `HELIUS_API_KEY` | No | — | Enhanced wallet data |
| `HELIUS_API_BASE` | No | `https://api.helius.xyz` | Helius API base |
| `HELIUS_BALANCE_CACHE_TTL_MS` | No | `300000` | Helius balance cache TTL |
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
| `PRIORITY_MICRO_LAMPORTS` | No | `50000` | Priority fee micro-lamports for transactions |
| `OKX_API_BASE` | No | `https://web3.okx.com` | OKX API base |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenRouter base |
| `MINIMAX_BASE_URL` | No | `https://api.minimax.io/v1` | MiniMax base |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base |
| `LOCAL_LLM_BASE_URL` | No | `http://localhost:1234/v1` | Local LLM (LM Studio/Ollama) |
| `AGENT_MERIDIAN_API_URL` | No | `https://api.agentmeridian.xyz/api` | Primary Agent Meridian relay endpoint |
| `HIVE_MIND_URL` | No | — | Alternative relay URL (fallback) |
| `HIVE_MIND_PUBLIC_API_KEY` | No | — | Primary Hive Mind public API key |
| `HIVE_MIND_API_KEY` | No | — | Alternative API key (fallback) |
| `HIVE_MIND_SYNC_DEBOUNCE_MS` | No | `300000` | Hive Mind sync debounce (5 min) |
| `HIVE_MIND_GET_TIMEOUT_MS` | No | `5000` | Hive Mind GET timeout |
| `HIVE_MIND_POST_TIMEOUT_MS` | No | `10000` | Hive Mind POST timeout |
| `SOLANA_BACKOFF_BASE_DELAY_MS` | No | `1000` | RPC rate-limit backoff base |
| `SOLANA_BACKOFF_MAX_DELAY_MS` | No | `30000` | RPC backoff max delay |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | No | `text` | `text` or `json` |
| `LOG_MAX_SIZE` | No | `10000000` | Bytes per log file before rotation |
| `LOG_MAX_FILES` | No | `7` | Number of rotated log files to keep |
| `SENTRY_DSN` | No | — | Sentry error tracking DSN |
| `SENTRY_TRACES_SAMPLE_RATE` | No | `0.1` | Sentry trace sample rate |
| `SENTRY_PROFILES_SAMPLE_RATE` | No | `0.1` | Sentry profile sample rate |
| `KAIROS_DB_PATH` | No | `src/core/kairos.db` | SQLite DB path (set if running from different CWD) |
| `BACKUP_DEST_DIR` | No | — | Offsite backup mount path |
| `HEALTH_PORT` | No | `3030` | Health endpoint port |
| `BRIEFING_LOOKBACK_MS` | No | `86400000` | Briefing lookback window (24h) |
| `WATCHDOG_POLL_INTERVAL_MS` | No | `60000` | Watchdog poll interval (1 min) |
| `CAVEMAN_ENABLED` | No | `false` | Enable prompt compression |

## Process Management (PM2)

```bash
# Start
pm2 start ecosystem.config.js --name kairos

# View logs
pm2 logs kairos

# Restart
pm2 restart kairos

# Stop
pm2 stop kairos

# Auto-start on boot (automated)
node scripts/setup-pm2-startup.js

# Auto-start on boot (manual equivalent)
pm2 save
pm2 startup  # run once after install, copies init script
```

## Health Check

```bash
curl http://localhost:3030/health
# Returns: ok
```

### Health Check Monitoring

The health endpoint is at `http://localhost:3030/health` (or `HEALTH_PORT` env var).

See `HEALTH_MONITORING.md` for full documentation including Better Uptime setup,
self-hosted cron monitoring, and security considerations.

**Quick-start: self-hosted cron (every minute):**
```bash
# Test manually first
node scripts/health-check.js

# Add to crontab
* * * * * cd /path/to/kairos && node scripts/health-check.js >> logs/health.log 2>&1
```

**Security note:** The `/health` endpoint requires no authentication and exposes
`positionCount`, `uptime`, and `memory`. Do not expose port 3030 directly to the
public internet without a reverse proxy that restricts access. See
`HEALTH_MONITORING.md` for recommended reverse-proxy patterns.
- Track: `up`, `position_count`, `last_cycle_timestamp`

## Backup & Restore

### Backup

```bash
# Manual
node scripts/backup-db.js

# Dry run first
node scripts/backup-db.js --dry-run

# Verify most recent backup (PRAGMA integrity_check)
node scripts/backup-db.js --verify

# Automated — add to crontab:
# 0 3 * * * cd /path/to/kairos && node scripts/backup-db.js >> logs/backup.log 2>&1
# Verify in a separate crontab entry:
# 30 3 * * * cd /path/to/kairos && node scripts/backup-db.js --verify >> logs/backup.log 2>&1
```

Backups stored in `backups/kairos-YYYY-MM-DD.db`. Script keeps last 7.

**Offsite backup:** Set `BACKUP_DEST_DIR` to a mount path (e.g., NFS, USB, SMB share). The local backup is always written first; the offsite copy is attempted after and failures are logged but non-fatal. Check the mount periodically to ensure it is reachable.

### Restore

```bash
# 1. Stop the agent
pm2 stop kairos

# 2. Restore the DB file from a backup
cp backups/kairos-YYYY-MM-DD.db src/core/kairos.db

# 3. Verify integrity
sqlite3 src/core/kairos.db "PRAGMA integrity_check;"

# 4. Restart the agent
pm2 restart kairos
```

### Log Rotation

Logs rotate automatically when file exceeds 10MB. Keeping 7 rotated files per type.

| File | Contents |
|------|----------|
| `logs/agent-YYYY-MM-DD.log` | All log levels |
| `logs/errors-YYYY-MM-DD.log` | Error-level only |

## Updating

```bash
# Pull latest
git pull

# Update dependencies (postinstall auto-patches anchor and rebuilds native modules)
npm install

# Restart
pm2 restart kairos
```

## Node Version Upgrades

`better-sqlite3` is a native addon — it uses Node.js ABI and must be rebuilt when the Node version changes. This happens automatically via the postinstall script, but if you install with `--ignore-scripts` you must run manually:

```bash
node scripts/rebuild-native.js
# or directly:
npm rebuild better-sqlite3
```

Supported Node versions: `20.x || 22.x || 23.x || 24.x || 25.x`

## Deployment Checklist

- [ ] `.env` file present with all required variables
- [ ] `pm2 start ecosystem.config.js --name kairos` running without errors
- [ ] `curl http://localhost:3030/health` returns 200
- [ ] Health monitoring configured (Better Uptime or self-hosted cron — see `HEALTH_MONITORING.md`)
- [ ] Alert channel (email/Telegram) confirmed working
- [ ] `logs/` directory created and writable
- [ ] `backups/` directory created
- [ ] `pm2 save` run to persist process list
- [ ] `pm2 startup` configured for reboot resilience

## Panic Recovery

If the bot goes sideways:

```bash
# Check what's running
pm2 list

# Force restart
pm2 restart kairos --update-env

# View last errors
pm2 logs kairos --err --lines 50

# If DB is corrupted:
#   cp backups/kairos-YYYY-MM-DD.db src/core/kairos.db
```

## Key Files

| Path | Purpose |
|------|---------|
| `src/index.js` | Main entry, cron orchestration, REPL |
| `src/core/lessons.js` | Learning system (re-exports threshold-evolver) |
| `src/core/threshold-evolver.js` | Threshold evolution algorithm |
| `src/core/state/index.js` | State barrel — registry, OOR, PnL, events, sync |
| `src/core/db.js` | Database connection |
| `src/core/logger.js` | Log rotation |
| `src/integrations/meteora.js` | DLMM pool interactions |
| `src/integrations/helius.js` | Wallet balances, swaps |
| `src/screening/discovery.js` | Pool discovery |
| `src/agent/index.js` | ReAct agent loop |
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

## Telegram Queue

When the agent is busy, inbound Telegram messages are queued (max 5) and drained when idle. This explains message pile-up during heavy activity (e.g., active management cycles or screening).

## bins_below Calculation

The screener uses a volatility-based `bins_below` calculation:

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```

- volatility 0 → 35 bins (tight position in stable pool)
- volatility 5+ → 69 bins (wide position in volatile pool)

Higher volatility = more bins below active bin = wider position = larger position footprint.

## LLM Fallback Chain

LLM calls retry up to 3 times. On HTTP 502/503/529 responses, the agent automatically switches from the primary model to `stepfun/step-3.5-flash:free` fallback. If all retries fail, the cycle errors out.

## Discord LP Army Listener (DEPRECATED/REMOVED)

The Discord listener using `discord.js-selfbot-v13` has been **removed**.

**Why removed:** Selfbots violate Discord Terms of Service. The `discord.js-selfbot-v13`
package is unmaintained and Discord periodically revokes selfbot tokens without warning.

**Migration path:** If you want to re-implement LP Army signal ingestion, use a proper
Discord bot account with a bot token (not a user token). See the archived
`discord-listener/README.md` pattern documented elsewhere, or use Discord webhooks.

**DISCORD_USER_TOKEN** — No longer used. Remove from `.env` if present.
