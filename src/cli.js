#!/usr/bin/env node
/**
 * kairos — Solana DLMM LP Agent CLI
 * Direct tool invocation with JSON output. Agent-native.
 */

import { die } from "./cli/utils.js";

// ─── DRY_RUN must be set before any tool imports ─────────────────
if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

// ─── Load .env from ~/.kairos/ if present ──────────────────────
const kairosDir = path.join(os.homedir(), ".kairos");
const kairosEnv = path.join(kairosDir, ".env");
if (fs.existsSync(kairosEnv)) {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: kairosEnv, override: false });
}

// ─── SKILL.md generation ──────────────────────────────────────────
const SKILL_MD = `# kairos — Solana DLMM LP Agent CLI

Data dir: ~/.kairos/

## Commands

### kairos balance
Returns wallet SOL and token balances.
\`\`\`
Output: { wallet, sol, sol_usd, usdc, tokens: [{mint, symbol, balance, usd_value}], total_usd }
\`\`\`

### kairos positions
Returns all open DLMM positions.
\`\`\`
Output: { positions: [{position, pool, pair, in_range, age_minutes, ...}], total_positions }
\`\`\`

### kairos pnl <position_address>
Returns PnL for a specific position.
\`\`\`
Output: { pnl_pct, pnl_usd, unclaimed_fee_usd, all_time_fees_usd, current_value_usd, lower_bin, upper_bin, active_bin }
\`\`\`

### kairos screen [--dry-run] [--silent]
Runs one AI screening cycle to find and deploy new positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### kairos manage [--dry-run] [--silent]
Runs one AI management cycle over open positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### kairos deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot] [--dry-run]
Deploys a new LP position. All safety checks apply.
\`\`\`
Output: { success, position, pool_name, txs, price_range, bin_step }
\`\`\`

### kairos claim --position <addr>
Claims accumulated swap fees for a position.
\`\`\`
Output: { success, position, txs, base_mint }
\`\`\`

### kairos close --position <addr> [--skip-swap] [--dry-run]
Closes a position. Auto-swaps base token to SOL unless --skip-swap.
\`\`\`
Output: { success, pnl_pct, pnl_usd, txs, base_mint }
\`\`\`

### kairos swap --from <mint> --to <mint> --amount <n> [--dry-run]
Swaps tokens via Jupiter. Use "SOL" as mint shorthand.
\`\`\`
Output: { success, tx, input_amount, output_amount }
\`\`\`

### kairos candidates [--limit 5]
Returns top pool candidates fully enriched: pool metrics, token audit, holders, smart wallets, narrative, active bin, pool memory.
\`\`\`
Output: { candidates: [{name, pool, bin_step, fee_pct, volume, tvl, organic_score, active_bin, smart_wallets, token: {holders, audit, global_fees_sol, ...}, holders, narrative, pool_memory}] }
\`\`\`

### kairos study --pool <addr> [--limit 4]
Studies top LPers on a pool. Returns behaviour patterns, hold times, win rates, strategies.
\`\`\`
Output: { pool, patterns: {top_lper_count, avg_hold_hours, avg_win_rate, ...}, lpers: [{owner, summary, positions}] }
\`\`\`

### kairos token-info --query <mint_or_symbol>
Returns token audit, mcap, launchpad, price stats, fee data.
\`\`\`
Output: { results: [{mint, symbol, mcap, launchpad, audit, stats_1h, global_fees_sol, ...}] }
\`\`\`

### kairos token-holders --mint <addr> [--limit 20]
Returns holder distribution, bot %, top holder concentration.
\`\`\`
Output: { mint, holders, top_10_real_holders_pct, bundlers_pct_in_top_100, global_fees_sol, ... }
\`\`\`

### kairos token-narrative --mint <addr>
Returns AI-generated narrative about the token.
\`\`\`
Output: { mint, narrative }
\`\`\`

### kairos pool-detail --pool <addr> [--timeframe 5m]
Returns detailed pool metrics for a specific pool.
\`\`\`
Output: { pool, name, bin_step, fee_pct, volume, tvl, volatility, ... }
\`\`\`

### kairos search-pools --query <name_or_symbol> [--limit 10]
Searches pools by name or token symbol.
\`\`\`
Output: { pools: [{pool, name, bin_step, fee_pct, tvl, volume, ...}] }
\`\`\`

### kairos active-bin --pool <addr>
Returns the current active bin for a pool.
\`\`\`
Output: { pool, binId, price }
\`\`\`

### kairos wallet-positions --wallet <addr>
Returns DLMM positions for any wallet address.
\`\`\`
Output: { wallet, positions: [...], total_positions }
\`\`\`

### kairos config get
Returns the full runtime config.

### kairos config set <key> <value>
Updates a config key. Parses value as JSON when possible.
\`\`\`
Valid keys: minTvl, maxTvl, minVolume, maxPositions, deployAmountSol, managementIntervalMin, screeningIntervalMin, managementModel, screeningModel, generalModel, autoSwapAfterClaim, minClaimAmount, outOfRangeWaitMinutes
\`\`\`

### kairos lessons [--limit 50]
Lists all lessons from lessons.json. Shows rule, tags, pinned status, outcome, role.
\`\`\`
Output: { total, lessons: [{id, rule, tags, outcome, pinned, role, created_at}] }
\`\`\`

### kairos lessons add <text>
Adds a manual lesson with outcome=manual, role=null (applies to all roles).
\`\`\`
Output: { saved: true, rule, outcome, role }
\`\`\`

### kairos pool-memory --pool <addr>
Returns deploy history for a specific pool from pool-memory.json.
\`\`\`
Output: { pool_address, known, name, total_deploys, win_rate, avg_pnl_pct, last_outcome, notes, history }
\`\`\`

### kairos evolve
Runs evolveThresholds() over all closed position data and updates user-config.json.
\`\`\`
Output: { evolved, changes, rationale }
\`\`\`

### kairos blacklist add --mint <addr> --reason <text>
Permanently blacklists a token mint so it is never deployed into.
\`\`\`
Output: { blacklisted, mint, reason }
\`\`\`

### kairos blacklist list
Lists all blacklisted token mints with reasons and timestamps.
\`\`\`
Output: { count, blacklist: [{mint, symbol, reason, added_at}] }
\`\`\`

### kairos performance [--limit 200]
Shows all closed position performance history with summary stats.
\`\`\`
Output: { summary: { total_positions_closed, total_pnl_usd, avg_pnl_pct, win_rate_pct, total_lessons }, count, positions: [...] }
\`\`\`

### kairos start [--dry-run]
Starts the autonomous agent with cron jobs (management + screening).

## Flags
--dry-run     Skip all on-chain transactions
--silent      Suppress Telegram notifications for this run
`;

fs.mkdirSync(kairosDir, { recursive: true });
fs.writeFileSync(path.join(kairosDir, "SKILL.md"), SKILL_MD);

// ─── Parse args ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const subcommand = argv.find(a => !a.startsWith("-"));
const sub2 = argv.filter(a => !a.startsWith("-"))[1]; // for "config get/set"
const silent = argv.includes("--silent");

if (!subcommand || subcommand === "help" || argv.includes("--help")) {
  process.stdout.write(SKILL_MD);
  process.exit(0);
}

// ─── Parse flags ──────────────────────────────────────────────────
const { values: flags } = parseArgs({
  args: argv,
  options: {
    pool:       { type: "string" },
    amount:     { type: "string" },
    position:   { type: "string" },
    from:       { type: "string" },
    to:         { type: "string" },
    strategy:   { type: "string" },
    query:      { type: "string" },
    mint:       { type: "string" },
    wallet:     { type: "string" },
    timeframe:  { type: "string" },
    reason:     { type: "string" },
    "bins-below": { type: "string" },
    "bins-above": { type: "string" },
    "amount-x":   { type: "string" },
    "amount-y":   { type: "string" },
    "bps":        { type: "string" },
    "no-claim":   { type: "boolean" },
    "skip-swap":  { type: "boolean" },
    "dry-run":    { type: "boolean" },
    "silent":     { type: "boolean" },
    limit:        { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

// ─── Command registry ─────────────────────────────────────────────
const COMMAND_PATHS = {
  balance:           "./cli/commands/balance.js",
  positions:         "./cli/commands/positions.js",
  pnl:               "./cli/commands/pnl.js",
  candidates:        "./cli/commands/candidates.js",
  "token-info":      "./cli/commands/token-info.js",
  "token-holders":   "./cli/commands/token-holders.js",
  "token-narrative": "./cli/commands/token-narrative.js",
  "pool-detail":     "./cli/commands/pool-detail.js",
  "search-pools":    "./cli/commands/search-pools.js",
  "active-bin":      "./cli/commands/active-bin.js",
  "wallet-positions":"./cli/commands/wallet-positions.js",
  deploy:            "./cli/commands/deploy.js",
  claim:             "./cli/commands/claim.js",
  close:             "./cli/commands/close.js",
  swap:              "./cli/commands/swap.js",
  screen:            "./cli/commands/screen.js",
  manage:            "./cli/commands/manage.js",
  config:            "./cli/commands/config.js",
  study:             "./cli/commands/study.js",
  start:             "./cli/commands/start.js",
  lessons:           "./cli/commands/lessons.js",
  "pool-memory":     "./cli/commands/pool-memory.js",
  evolve:            "./cli/commands/evolve.js",
  blacklist:         "./cli/commands/blacklist.js",
  performance:       "./cli/commands/performance.js",
};

// ─── Dispatch ──────────────────────────────────────────────────────
const cmdPath = COMMAND_PATHS[subcommand];
if (!cmdPath) {
  die(`Unknown command: ${subcommand}. Run 'kairos help' for usage.`);
}

// Derive export name: "token-info" → "tokenInfoCmd", "balance" → "balanceCmd"
const toCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const cmdExport = toCamel(subcommand) + "Cmd";
const mod = await import(cmdPath);
const handler = mod[cmdExport];
if (!handler) {
  die(`Command ${subcommand} has no ${cmdExport} export`);
}
handler(argv, flags, sub2, silent);
