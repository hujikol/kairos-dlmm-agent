# Deterministic decisions, paper trading, and deployment

## Execution boundary

Screening and management do not invoke an LLM. Free-form chat cannot execute tools or change configuration. Use named commands for operational actions. Numbered REPL picks and `auto` use the same screening gate as scheduled cycles. Legacy prose position instructions remain stored but no longer override numeric exits.

Screening applies existing discovery filters, token correlation checks, pool cooldowns and toxic-token memory. It then requires a SOL quote token, a base mint, a valid active bin, finite entry metrics, a passing simulation with positive net daily yield, risk score at most 40 and confidence at least 40. Rugpull/wash flags reject a pool. Pools with at least three historical deployments require a win rate of at least 50%. Smart-wallet signals cannot override a failed gate.

Eligible candidates rank by highest estimated daily fees, lowest risk, highest confidence, net daily yield, then pool address. Each cycle may fill available slots sequentially, with at most one position per base mint; a failed or unconfirmed deployment stops the batch. Deployment uses operator configuration for strategy and range, normal conviction sizing, and the existing executor safety checks. Circuit breakers, position limits and reserve requirements remain in force. Missing data blocks deployment.

The simulation uses an explicit 24-hour volume request and the USD price of one SOL. It does not mistake total wallet value for SOL price or a five-minute volume window for daily volume. Its 2% daily ROI floor is applied daily. Estimates are screening inputs, not guaranteed returns.

## AI rule updates

The AI can propose exactly three numeric entry thresholds:

| Field | Initial value | Fixed allowed range | Automatic direction |
| --- | --- | --- | --- |
| `minOrganic` | 60 | 60–90 | Increase |
| `maxVolatility` | 10 | 2–10 | Decrease |
| `minFeeTvl` | 0.05 | 0.05–1 | Increase |

Updates cannot alter capital, sizing, exits, schedules, credentials, or executable code. The proposal request has no tools. It includes numeric training records, not narrative instructions, wallet identities, or holdout outcomes.

Activation requires all of these checks:

1. Exactly the allowed keys; finite numeric values within fixed bounds.
2. Tightening only, with a maximum 10% change per field per update.
3. At least 30 eligible closed trades in the relevant mode, from a bounded recent history.
4. A chronological 70% training / 30% validation split.
5. Improved mean PnL and no lower win rate in both splits.
6. At least five retained trades and at least 50% coverage in each split.
7. At most one recorded proposal per mode per 24 hours. Concurrent updates are rejected.

Accepted rules and their validation records commit together in SQLite. Failed proposals leave active rules intact. There is no automatic relaxation: replay of closed trades does not establish outcomes for trades that were never taken. Repeatedly consulting a recent holdout can also overfit; this check is not evidence of future profitability.

Telegram and the interactive terminal support:

```text
/rules
/rules update
/rules history
/rules rollback
```

`/evolve` in the terminal and `kairos evolve` use the validated update path. Automatic proposals run after every fifth close when enough history exists. Rollback restores a previous activated ruleset in the current mode. Operator configuration edits remain explicit operator actions.

## DB-funded dry run

`DRY_RUN=true` uses a persistent paper wallet, seeded once with 10 SOL. Set `KAIROS_PAPER_START_SOL` before the first run to choose another positive seed. Restarts do not refill an existing wallet.

Deploys debit paper SOL; claims and closes credit the ledger atomically. Duplicate closes cannot pay twice. Token swaps use market prices and a fixed 0.3% simulated cost. Paper positions and their closed outcomes live in `paper_positions`; balances live under `paper_wallet` in `kv_store`. They do not modify live positions or live performance rows. The paper wallet cannot sign or submit a transaction, and paper positions cannot be closed or claimed in live mode. A wallet private key is not required for dry run. RPC access still supports read-only pool data.

SOL prices come from [Jupiter Price API V3](https://developers.jup.ag/docs/price), which may require `JUPITER_API_KEY`. Missing prices block paper operations. `KAIROS_PAPER_SOL_PRICE_USD` provides an explicit fixed SOL price for controlled tests; it is not a market quote. That override supports SOL and USDC only.

Paper valuation approximates LP inventory with a constant-product price response and accrues pro-rata fees only when both sampled endpoints are in range. It does not reproduce exact DLMM bin fills, intrainterval crossings, slippage, transaction failures, or all chain costs. Paper PnL is labelled simulation evidence.

Paper rules use a separate `paper_decision_rules` key and separate update history. Live proposals receive saved paper metrics as supplementary training context. Live activation still requires at least 30 eligible **live** trades and validation against live outcomes. Switching to live does not automatically promote paper rules. Preserve the same SQLite database/volume to retain learning across modes.

Telegram replies remain enabled in dry run and carry `[PAPER]`. Briefing and performance summaries use paper history in paper mode.

## Runtime findings and repairs

| Observed code defect | Repair |
| --- | --- |
| Read-only Telegram commands bypassed handler limits | All commands obey three active handlers and ten waiting commands |
| Empty drains scheduled unnecessary callbacks | Drains schedule work only when queued work can start |
| REPL completion left Telegram work waiting | Both REPL completion and startup completion trigger drain |
| Screening called `.catch()` on a void drain function | Removed incorrect promise assumption |
| Outbound and LPAgent queues could grow without limits | Both queues cap waiting work at 100; callers receive overflow errors |
| TTL SDK caches could grow with distinct pools inside a TTL window | Each cache caps entries at 100 |
| Pool notes and full-history aggregate reads grew over time | Notes keep the last 50; aggregates run in SQL |
| Direct Telegram timeout timers survived errors | AbortSignal deadlines replace manual timer ownership |
| ReAct requests retained tool histories and could initiate trades | Runtime ReAct execution removed; AI only proposes rules |
| Cycle and daily-snapshot writers referenced nonexistent columns | Writes now use migration-defined columns |
| Live bid-ask range guard rejected `bins_above=0` despite executor requiring it | Inclusive active-bin boundary accepted |

Diagnostics remain in `logs/diagnostics-<PID>.jsonl`. Enable with `KAIROS_DIAGNOSTICS=true`. Queue stress checks establish bounded behavior for mocked commands; they do not establish memory stability over days of live RPC/SDK use. Do not increase the watchdog heap threshold to hide continuing growth.

## Docker

The image uses Node 24, installs the locked production dependencies and native build prerequisites, runs as the `node` user, and excludes local secrets/databases. Compose provides persistent data/log volumes, a 2 GB memory limit, a 1.5 GB JS heap limit, capped container logs, an init process, SIGTERM grace time, and a loopback-only health port. Settings follow the [Compose service reference](https://docs.docker.com/reference/compose-file/services/).

First deploy in paper mode:

```sh
cp .env.example .env
# Set RPC_URL and market-data credentials in .env.
# Set the LLM key only if rule proposals are wanted.
DRY_RUN=true docker compose up -d --build
docker compose logs -f kairos
curl http://127.0.0.1:3030/live
curl http://127.0.0.1:3030/health
```

`/live` checks process responsiveness. `/health` also checks RPC connectivity. A healthy process does not prove that screening, signing, or remote APIs work. Docker health status does not itself restart an unhealthy running process.

First startup copies `profiles/high-volume-paper.json` into `/data/user-config.json` only if it is absent. Subsequent settings persist. Environment paths are `KAIROS_DB_PATH`, `KAIROS_USER_CONFIG_PATH`, and `KAIROS_GMGN_CONFIG_PATH`. Edit or copy configuration through the container into `/data`, never into the image. GMGN configuration is optional at `/data/gmgn-config.json`.

Keep one process per wallet/database. Stop any existing local agent before enabling live deployment. To preserve existing learning, use SQLite's backup API for a running database, or stop the writer before copying the database and its required journal files into the data volume. Never copy only the main file from an actively written WAL database. Keep a backup before first startup; additive migrations run automatically. `docker compose down` preserves named volumes; `docker compose down -v` deletes the paper wallet and learning.

When ready for live operation, set the wallet key and other required credentials in `.env`, then explicitly run:

```sh
DRY_RUN=false docker compose up -d --force-recreate
```

Do not embed credentials in images or commit `.env`. Prefer server secret management when deploying remotely.

## Verification and limits

Offline checks cover actual deterministic screening through confirmed-position handling, rule activation/rejection/rollback, paper ledger settlement and restart persistence, transaction-submission rejection, and Telegram concurrency/draining. The Telegram stress check runs 1,500 additional commands and checks retained heap when Node runs with `--expose-gc`.

The legacy live discovery smoke test is opt-in with `KAIROS_LIVE_TESTS=true`; unit tests do not depend on that external service. Run it explicitly with valid market/RPC configuration when live connectivity verification is desired.

A fixture-backed non-TTY startup check also passed `/live`, `/health`, and SIGTERM exit with a fresh 10 SOL paper wallet and no private key. This checks local orchestration only.

On this host, Compose configuration validates but the image cannot be built or run: Docker's daemon is unavailable, and the installed Docker.app reports a missing executable. Linux image installation, container startup, live transactions, and a multiday runtime soak remain unverified.


## High-volume paper starting preset

`profiles/high-volume-paper.json` is a paper-only starting configuration. It limits exposure to three distinct tokens, 0.25 SOL per position and a 0.5 SOL gas reserve. With the default 10 SOL paper seed, three positions expose at most 7.5% of starting SOL. The daily realized loss breaker is $15, base stop loss is -8%, trailing protection activates at +1% with a 0.5 percentage-point drop, and profit-taking starts at +3%. Price gaps, liquidity changes, and delayed data can exceed these exit thresholds; they are not loss guarantees.

Discovery requires at least $1,000 volume in five minutes, $50,000–$5 million active liquidity, 1,000 holders, token age at least 12 hours, and organic score at least 75. The entry gate additionally requires $100,000 daily volume and daily volume/active-TVL turnover of at least 2. Fee-ranked selection does not bypass risk or simulation checks. The 0.01% discovery fee/TVL floor uses the five-minute window; the numeric rule uses daily realized fee/TVL when available. Do not compare these windows as if they were identical.

Token audits must show disabled mint and freeze authorities, top-holder concentration at most 25%, bots and bundled holdings at most 15%, and at least 30 SOL of cumulative token fees. Suspicious audits and high-risk classifications reject entry. Missing audit fields reject entry. These checks reduce some rug signals but cannot establish that a token is safe. See [Jupiter's Organic Score explanation](https://developers.jup.ag/blog/what-is-organic-score) and [Meteora's DLMM fee and impermanent-loss explanation](https://meteoraag.medium.com/dlmm-new-dynamic-liquidity-protocol-to-boost-lp-fees-on-solana-84867bad0907).

Run the preset directly with a separate database, preserving the existing live database:

```sh
DRY_RUN=true KAIROS_USER_CONFIG_PATH=profiles/high-volume-paper.json \
  KAIROS_DB_PATH=logs/high-volume-paper.db npm start
```

Run a bounded diagnostic session:

```sh
npm run paper:soak -- 300
```

The diagnostic runner passes only read-only RPC and Jupiter price credentials to its child. It never passes a wallet key, Telegram token, or LLM key. It creates a new paper database and diagnostics directory under `logs/`, exercises local Telegram handlers, measures GC-normalized heap samples, and shuts down automatically. It does not send messages through Telegram. A new directory isolates each diagnostic experiment; use the direct-start database above for continuous paper learning.

A synthetic-market lifecycle soak is opt-in:

```sh
KAIROS_SOAK_TEST=true node --expose-gc --experimental-test-module-mocks \
  --test test/paper-soak.check.mjs
```

This uses the real paper ledger, cycles, executor, rule gates and Telegram dispatcher with synthetic market providers. It checks three concurrent tokens, repeated closes/redeploys, 1,800 commands, bounded handler count, and retained heap. It does not prove production SDK/RPC behavior.
