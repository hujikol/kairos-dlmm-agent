# Discord Integration — Re-implementation Plan

## Context

Discord LP Army signal monitoring disabled (2026-04-13). Selfbot approach (`discord.js-selfbot-v13`) violated Discord ToS and used deprecated library.

**Goal:** Rebuild as proper Discord bot — bot token, official `discord.js` v14+, compliant with Discord Developer Terms.

---

## Architecture

```
discord-bot/               # New top-level dir inside kairos/
├── bot.js                 # Bot entry, slash commands, message ingestion
├── signals/
│   ├── queue.js           # Load/save discord-signals.json
│   └── precheck.js        # Pool address extraction + pre-check pipeline
├── commands/
│   ├── start.js           # /start — begin monitoring channel
│   └── stop.js            # /stop — halt monitoring
└── monitor/
    └── lp-army.js         # LP Army channel watcher, Solana address regex
```

**Files deleted:**
- `src/discord.js` — selfbot entry
- `src/discord-pre-checks.js` — pre-check pipeline (logic preserved, refactored)

**Files modified:**
- `src/index.js` — re-add lazy `import('./discord-bot/bot.js')` behind `DISCORD_BOT_TOKEN`
- `src/cli.js` — re-add `discord-signals` command

---

## Env vars

| Var | Present | Purpose |
|-----|---------|---------|
| `DISCORD_BOT_TOKEN` | No | Bot token from Discord Developer Portal |
| `DISCORD_GUILD_ID` | No | Guild to register slash commands |
| `DISCORD_CHANNEL_IDS` | No | Comma-sep channel IDs to monitor |
| `DISCORD_MIN_FEES_SOL` | Yes | Reuse existing threshold var |

---

## Phases

### Phase 1 — Bot Shell

- Create `discord-bot/` dir
- Install `discord.js` v14 (not selfbot variant)
- Basic bot with `Client` + `GatewayIntentBits`
- `DISCORD_BOT_TOKEN` gate in `index.js`
- `kairos discord-signals` CLI command restored

**Verify:** Bot connects, slash commands register, `!kairos start` in monitored channel triggers queue write.

### Phase 2 — Channel Monitoring

- LP Army channel message ingestion
- Solana address regex extraction (`/[1-9A-HJ-NP-Za-km-z]{32,44}/g`)
- Write raw signals to `discord-signals.json` (same format as before)
- Bot slash commands: `/start #channel`, `/stop #channel`

**Verify:** Manual message with pool address → `discord-signals.json` entry.

### Phase 3 — Pre-check Pipeline

- Migrate `discord-pre-checks.js` logic into `discord-bot/signals/precheck.js`
- Run pre-checks async after signal queued
- Update `discord-signals.json` with `rug_score`, `base_mint`, `pool_address`, `status`
- Status transitions: `pending` → `prechecked` → `ready` | `rejected`

**Verify:** Signal auto-populates with pool data and pre-check result.

### Phase 4 — Alerts + Integration

- Telegram notification when signal promoted to `ready`
- Agent picks up via existing screening flow (or new dedicated cron)
- `/learn` command extension to query signal history

**Verify:** Full round-trip: Discord message → queue → pre-check → Telegram alert.

---

## Pre-check Pipeline (preserved logic)

```
Discord message
  → Extract Solana addresses (regex)
  → Filter: only pools (verify via RPC getAccountInfo)
  → Min fees check (DISCORD_MIN_FEES_SOL)
  →rug_score via Jupiter token API (reuse from existing tools)
  → Write to discord-signals.json
```

Existing `src/discord-pre-checks.js` — reference for logic. Most functions reusable:
- `loadConfig()` → extract min fees
- `fetchPool` (RPC) → verify pool exists
- `getPoolFees` (dlmm) → min fee gate
- `getRugScore` (Jupiter)

---

## Risks

- **Slash command permissions** — bot needs `USE_APPLICATION_COMMANDS` intent + proper guild permissions
- **Message content intent** — requires `MessageContentIntent` privileged intent (approved per-app)
- **Rate limits** — LP Army channels high-volume; implement per-user/message debounce
- **Pre-check latency** — async queue prevents blocking; pre-check runs in background

---

## Stack

- `discord.js` v14 (official, bot)
- Same env var names where possible (re-use `DISCORD_USER_TOKEN` → `DISCORD_BOT_TOKEN`)
- `discord-signals.json` format unchanged (backward compatible)
