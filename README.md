# Meridian Operations Guide

> This repo is a heavily modified fork of [yunus-0x/meridian](https://github.com/yunus-0x/meridian). It includes SQLite migrations, smart-wallet tracking, auto-swap on close/claim, priority fee support, pool memory, Darwin-style signal weight evolution, Discord listener integration, and numerous stability fixes not present in the upstream repo.

Setup, daily use, maintenance, and profitability optimization.

---

## Table of Contents

1. [Setup](#1-setup)
2. [Using the Agent](#2-using-the-agent)
3. [Maintenance](#3-maintenance)
4. [Improving Profitability](#4-improving-profitability)

---

## 1. Setup

### Prerequisites

- **Node.js 18+** — check with `node -v`
- **Solana wallet** — a funded wallet with a base58 or JSON-array private key
- **OpenRouter API key** — get one from [openrouter.ai](https://openrouter.ai)
- **Solana RPC endpoint** — Helius recommended; free tier is sufficient for light use
- **Telegram bot token** (optional) — for notifications and remote control

### Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run the interactive setup wizard
npm run setup
```

The wizard creates `.env` and `user-config.json` interactively (~2 minutes).

### Manual Setup

**`.env` file:**
```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key
TELEGRAM_BOT_TOKEN=123456:ABC...    # optional
TELEGRAM_CHAT_ID=                     # auto-filled on first message
DRY_RUN=true                          # ALWAYS start here
```

**`user-config.json`:**
```bash
cp user-config.example.json user-config.json
```

### Recommended Starting Profile (Beginner)

These are conservative defaults in `user-config.json` for your first week:

```json
{
  "screening": {
    "minFeeActiveTvlRatio": 0.05,
    "minTvl": 10000,
    "maxTvl": 150000,
    "minVolume": 500,
    "minOrganic": 60,
    "minHolders": 500,
    "minMcap": 150000,
    "maxMcap": 10000000,
    "minBinStep": 80,
    "maxBinStep": 125,
    "timeframe": "5m",
    "maxBundlersPct": 30,
    "maxTop10Pct": 60,
    "blockedLaunchpads": ["Pump.fun"]
  },
  "management": {
    "deployAmountSol": 0.5,
    "maxDeployAmount": 50,
    "maxPositions": 3,
    "gasReserve": 0.2,
    "positionSizePct": 0.35,
    "minSolToOpen": 0.55,
    "outOfRangeWaitMinutes": 30,
    "stopLossPct": -15
  },
  "schedule": {
    "managementIntervalMin": 10,
    "screeningIntervalMin": 30
  }
}
```

> **Rule of thumb**: Run in `DRY_RUN=true` for at least 3-5 cycles before going live. Verify the agent deploys into pools you'd feel comfortable being in.

### Hive Mind (Optional — Collective Intelligence)

Pool consensus data from other Meridian operators. Share lessons, receive crowd wisdom.

```bash
node -e "import('./hive-mind.js').then(m => m.register('https://meridian-hive-api-production.up.railway.app', 'YOUR_TOKEN'))"
```

Get `YOUR_TOKEN` from the private Telegram discussion. No private keys or balances are ever sent.

### Discord Listener (Optional — Signal Feed)

Watches LP Army channels in Discord for token calls, queues them as priority candidates for the screener.

```bash
cd discord-listener
npm install
```

Add to root `.env`:
```env
DISCORD_USER_TOKEN=your_token
DISCORD_GUILD_ID=server_id
DISCORD_CHANNEL_IDS=ch1,ch2
DISCORD_MIN_FEES_SOL=5
```

---

## 2. Using the Agent

### Running Modes

**Autonomous mode (recommended):**
```bash
npm run dev           # dry run (no on-chain tx)
npm start             # live mode
```

The REPL shows cycle countdowns:
```
[manage: 8m 12s | screen: 24m 3s]
>
```

**CLI (direct tool commands):**
```bash
meridian screen --dry-run     # one screening cycle
meridian manage --dry-run     # one management cycle
meridian positions            # list open positions
meridian balance              # check wallet
meridian config set key val   # update config at runtime
```

**Claude Code (interactive terminal AI):**
```bash
claude
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
```

### REPL Commands

| Command | Description |
|---------|-------------|
| `/status` | Wallet balance, open positions |
| `/candidates` | Re-screen top pool candidates |
| `/learn` | Study top LPers across candidate pools |
| `/thresholds` | Current screening thresholds + performance stats |
| `/evolve` | Trigger threshold evolution (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| Free text | Chat with the agent about any pool, position, or analysis |

### Telegram Commands

| Command | Action |
|---------|--------|
| `/positions` | List open positions with in-range progress bars |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a management instruction on a position (e.g. "close at 5% profit") |
| `/balance` | Detailed wallet balance (SOL + token holdings with USD values) |
| `/status` | Wallet balance + open positions overview |
| `/candidates` | Refresh and display top pool candidates |
| `/screen` | Manually trigger a full screening cycle |
| `/swap-all` | Sweep all non-SOL tokens in wallet back to SOL |
| `/briefing` | Morning briefing — last 24h activity summary |
| `/learn` | Study top LPers from the best current pool and save lessons |
| `/learn <addr>` | Study top LPers from a specific pool address |
| `/thresholds` | Current screening thresholds + performance stats |
| `/evolve` | Manually trigger threshold evolution from performance data |
| `/stop` | Graceful shutdown |

You can also chat freely with the agent via Telegram — any free-form text runs through the LLM like the REPL.

### Understanding What the Agent Is Doing

**Screening cycle** (default every 30 min):
1. Fetches trending/trending pools from Meteora
2. Filters by your configured thresholds (TVL, volume, organic score, holders, mcap)
3. Enriches candidates with token audit and smart money data
4. LLM picks the best candidate and deploys (or passes if none qualify)

**Management cycle** (default every 10 min):
1. Fetches all open positions via `getMyPositions()`
2. Calls `getPositionPnl()` for each position to check yield health
3. Detects out-of-range positions (waiting `outOfRangeWaitMinutes` before acting)
4. Claims accrued fees when beneficial
5. Decides: HOLD, CLOSE, or REDEPLOY
6. On close: auto-swaps base tokens back to SOL

---

## 3. Maintenance

### Monitoring

**Daily checks:**
- Run `/status` to verify wallet balance and position health
- Check Telegram notifications for OOR alerts and cycle reports
- Review management cycle reasoning — is the agent holding or closing for good reasons?

**Weekly review:**
```bash
meridian performance --limit 50   # closed position history
meridian lessons                  # what the agent has learned
meridian thresholds               # current screening config
```

**Database health:**
The SQLite database (`meridian.db`) stores all position history, lessons, and performance. No manual maintenance needed — but keep periodic backups:
```bash
cp meridian.db meridian.db.backup.$(date +%F)
```

### State Files

All JSON state files are gitignored and auto-managed:

| File | Purpose |
|------|---------|
| `state.json` | Position registry — tracks active positions, bin ranges, OOR timestamps |
| `pool-memory.json` | Per-pool deploy history, snapshots |
| `smart-wallets.json` | Tracked KOL/winner wallets |
| `token-blacklist.json` | Permanently blocked token mints |
| `user-config.json` | Runtime config (mutated by `evolveThresholds` and manual updates) |
| `strategy-library.json` | Saved LP strategy definitions |

### Lessons System

After every closed position, the agent:
1. Records performance data (PnL, range efficiency, fees, hold time)
2. Derives a structured lesson (what worked / what failed)
3. Injects lessons into future system prompts for better decisions
4. Auto-evolves screening thresholds every 5 closed positions

**Add manual lessons:**
```bash
meridian lessons add "Never deploy into pump.fun tokens under 2h old"
```

**View lessons:**
```bash
meridian lessons
```

**Pin important lessons** (always injected into prompts):
```bash
meridian lessons pin <lesson_id>
```

### Threshold Evolution

After 5+ closed positions, evolution automatically adjusts `user-config.json` thresholds:

- **`maxBinStep`** — tightened if losing positions cluster at low bin steps, loosened if all winners are at higher steps
- **`minFeeActiveTvlRatio`** — raised if winners consistently have higher fee ratios than losers
- **`minOrganic`** — raised if there's a clear spread between winner and loser organic scores

Reset evolution data (wipe performance and lessons):
```bash
# In JS console or script
import { clearPerformance, clearAllLessons } from './lessons.js';
clearPerformance();
clearAllLessons();
```

### Updating

```bash
git pull
npm install
```

Check the git log for breaking changes before restart.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Empty LLM responses | Model hit its output limit | Switch to a model with higher `maxOutputTokens`; minimum is 2048 |
| 502/503/529 errors | OpenRouter endpoint down | Agent auto-fails-over to `stepfun/step-3.5-flash:free` |
| Positions never close | Model being too patient | Set tighter `stopLossPct` or lower `outOfRangeWaitMinutes` |
| Agent deploys into bad pools | Screening thresholds too loose | Raise `minOrganic`, `minVolume`, `minHolders` |
| "No candidates pass filter" | Screening thresholds too strict | Lower `minMcap`, `minTvl`, or increase `timeframe` |
| Token not swapping after close | Token value below $0.10 dust threshold | By design — dust swaps cost more gas than the tokens are worth |

---

## 4. Improving Profitability

### Position Sizing and Compounding

The deploy formula is: `clamp(deployable × positionSizePct, min=deployAmountSol, max=maxDeployAmount)`

Key variables:
- **`deployAmountSol`** — floor per position (default 0.5 SOL)
- **`positionSizePct`** — fraction of deployable balance to use (default 35%)
- **`maxDeployAmount`** — ceiling per position (default 50 SOL)

**Compounding effect**: As your balance grows, position sizes grow automatically. A $300 balance at 35% = $105/position. At $3000, it's $1050/position. This is how the agent scales — don't set `positionSizePct` too low or you'll cap the growth curve.

**Sweet spot**: `positionSizePct` between 0.30-0.40 with `maxPositions = 3`. This gives diversification while keeping individual positions meaningful.

### Strategy Selection

Strategies are tracked and performance-measured in `strategy-library.json` and the DB `performance` table. The LLM sees win rates per strategy in its prompt.

**Common strategies:**
- **`bid_ask`** — wider range, captures fees on both sides; best for stable/ranging tokens
- **`spot`** — concentrated, maximum fee yield; best for trending tokens with clear direction
- **`curve`** — follows the volume curve; good middle ground

**How to pick:**
- Check strategy win rates: `getStrategyStats()` in lessons.js
- Prefer bid_ask for low-volatility pools (vol < 3)
- Prefer spot for high-conviction, high-fee pools (vol >= 5)
- Let the LLM choose based on the strategy performance data injected into its prompt

### Managing Volatility

Higher volatility = wider bin ranges needed. The agent calculates `bins_below` automatically:
```
bins_below = round(35 + (volatility/5) * 34), clamped [35, 69]
bins_above = 0 (asymmetric — protects downside only)
```

- **Low vol (0-2)**: 35-48 bins, check every 10 min
- **Medium vol (2-5)**: 48-62 bins, check every 5 min
- **High vol (5+)**: 62-69 bins, check every 3 min

The agent automatically adjusts `managementIntervalMin` after deploy based on pool volatility (rule 4 in the behavioral core). Trust this — high volatility pools need more frequent OOR monitoring.

### When to Close vs Hold

**Close a position when:**
- Price dropped below your `stopLossPct` (default -15%)
- Volume has collapsed and fees have evaporated
- Pool is OOR for longer than `outOfRangeWaitMinutes` AND price isn't recovering
- The token is flagged as rugpull/honeypot after deploy
- You have a significantly better opportunity (opportunity cost)

**Hold (the default) when:**
- Pool is OOR but price trend suggests it will return
- Small losses (< 5%) — gas costs eat the benefit
- Fees are still accruing even if price has moved
- Position is < 30 min old — give it time to work

### Reading Pool Signals

**Green flags:**
- `fee_active_tvl_ratio` above timeframe threshold (see scaling table below)
- Volume > $500 in your timeframe
- Smart wallets present and buying
- Organic score > 70
- Narrative is specific and identifiable

**Red flags:**
- `fee_active_tvl_ratio` below 0.02% (5m) — either bundled or dying pool
- Volume collapse after deploy (fees evaporate)
- `top10 > 60%` holder concentration
- `bundler_pct` from OKX > 30%
- No narrative + no smart wallets
- Pool memory shows prior losses

**Timeframe scaling for `fee_active_tvl_ratio`:**

| Timeframe | Decent | Good |
|-----------|--------|------|
| 5m | >= 0.02% | >= 0.05% |
| 15m | >= 0.05% | >= 0.1% |
| 1h | >= 0.2% | >= 0.5% |
| 4h | >= 0.8% | >= 2% |
| 24h | >= 3% | >= 8% |

### Configuration Tuning for Profitability

**Conservative (low risk, lower returns):**
```json
{
  "maxPositions": 2,
  "deployAmountSol": 0.3,
  "positionSizePct": 0.25,
  "minOrganic": 70,
  "minVolume": 1000,
  "minFeeActiveTvlRatio": 0.08,
  "outOfRangeWaitMinutes": 45,
  "stopLossPct": -10
}
```

**Balanced (recommended starting point):**
```json
{
  "maxPositions": 3,
  "deployAmountSol": 0.5,
  "positionSizePct": 0.35,
  "minOrganic": 60,
  "minVolume": 500,
  "minFeeActiveTvlRatio": 0.05,
  "outOfRangeWaitMinutes": 30,
  "stopLossPct": -15
}
```

**Aggressive (higher risk, more opportunities):**
```json
{
  "maxPositions": 5,
  "deployAmountSol": 1.0,
  "positionSizePct": 0.40,
  "minOrganic": 50,
  "minVolume": 200,
  "minFeeActiveTvlRatio": 0.03,
  "maxBundlersPct": 40,
  "outOfRangeWaitMinutes": 15,
  "stopLossPct": -20
}
```

### Using Discord Signals for Alpha

If you have the Discord listener running:
- LP Army channels often surface tokens before they hit trending lists
- Run `/screen` immediately when a signal fires — signals are processed as priority before normal screening
- The pre-check pipeline (dedup → blacklist → pool resolution → rug check → fees check) filters ~80% of signals before the LLM sees them
- Set `DISCORD_MIN_FEES_SOL=5` or higher to avoid junk pools

### Smart Wallet Tracking

Smart wallets (KOLs, top LPers) are tracked in `smart-wallets.json`. To build this list:

1. Run `/learn` or `/study-pool <addr>` to find top LPers
2. Look for wallets with high win rates and consistent returns
3. Add promising wallets to track: `meridian smart-wallets add --wallet <addr> --label "name"`
4. When a new pool deploy involves a tracked wallet, the screener surfaces this as a conviction signal

### Model Selection

The model affects decision quality. Default free models may produce suboptimal reasoning.

**Recommended (by budget):**
- **Free**: `openai/gpt-oss-20b:free` — functional, limited reasoning depth
- **Budget** ($5-10/mo): `openrouter/healer-alpha` — strong reasoning on pool selection
- **Premium** ($20+/mo): `anthropic/claude-sonnet-4-5` — best at nuanced risk assessment

Per-role model config in `user-config.json`:
```json
{
  "screeningModel": "anthropic/claude-sonnet-4-5",
  "managementModel": "openrouter/healer-alpha",
  "generalModel": "openai/gpt-oss-20b:free"
}
```

Investing in a better screening model has the highest ROI — this is where deploy/no-deploy decisions happen.

### Common Profit Leaks

1. **Gas waste from frequent closes** — The agent sometimes closes for tiny gains that are less than the gas cost. Trust the "patience is profit" core rule; it's embedded in the prompt.
2. **Not swapping after close** — The agent MUST swap base tokens to SOL after closing (for tokens >= $0.10). Check management cycle logs to verify this happens.
3. **Deploying into bundler tokens** — High `bundler_pct` tokens often rug within hours. The `maxBundlersPct` threshold (default 30%) is your first defense.
4. **Ignoring pool memory** — Previous losses on a pool are a strong skip signal. The agent checks `pool-memory.json` before deploying.
5. **Too many concurrent positions** — `maxPositions` limits how spread your capital gets. 3 is the sweet spot for a 0.5-3 SOL portfolio.
