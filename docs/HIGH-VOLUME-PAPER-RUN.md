# High-volume paper rules and runtime results

Tested on 13 October 2026 using Node 24.15.0. No wallet key or Telegram token was passed to diagnostic sessions. No real funds were deployed.

## Starting configuration

The local `.env` now selects `profiles/high-volume-paper.json`, `DRY_RUN=true`, and the separate persistent database `logs/high-volume-paper.db`. Existing credentials and the original live database remain intact. These settings apply on the next ordinary startup; the diagnostic runs below used separate databases.

The preset allows three distinct tokens with at most 0.25 SOL per position and a 0.5 SOL reserve. Starting with 10 paper SOL, the maximum initial allocation is 0.75 SOL. Screening runs every two minutes; management runs every minute.

Eligibility includes $100,000 daily volume, daily volume/active-TVL turnover of at least 2, $50,000 minimum active liquidity, 1,000 holders, a 12-hour token age, organic score at least 75, and volatility at most 5. Entry requires disabled mint/freeze authorities, bounded holder/bot/bundle concentration, sufficient historical token fees, and passing simulation/risk checks. Missing audit information blocks entry. Eligible pools rank by estimated daily fees; execution fills available slots sequentially and rejects duplicate base tokens.

Base stop loss is -8%, profit-taking starts at +3%, and trailing protection activates at +1% with a 0.5 percentage-point drop. These are execution thresholds, not guarantees against gaps, rugs, impermanent loss, or negative account returns. The paper valuation model is approximate.

## Repairs found during this run

- Jupiter's token enrichment cache retained distinct tokens without a capacity limit. It now removes expired entries and caps retained tokens at 100. A regression test verifies eviction and reuse.
- Candidate recon requested narratives, additional wallet research and indicators that deterministic execution did not use. It now fetches the matched token audit only.
- Discovery passed already-started enrichment promises to a wrapper expecting functions. That wrapper rejected before observing the original promises, allowing a certificate error to crash the process through an unhandled rejection. The wrapper now observes the promises, applies a deadline, and clears its timer. A certificate-failure regression passes.
- The OKX relay fallback referenced a missing logger import. The import is restored so provider errors remain contained.
- The profile's smart-money requirement was previously not loaded into screening configuration. It now loads correctly. Audit and volume requirements remain mandatory in this profile; smart-wallet flags cannot force a deployment.

TLS verification remains enabled. Upstream certificate failures reject enrichment; they do not authorize trading with unknown audit fields.

## Observed results

| Session | Duration | Commands requested | Trading activity | End state |
| --- | --- | --- | --- | --- |
| Initial public-feed paper session | 5 minutes | 570 | No qualifying discovery candidates | 0 queued/active diagnostic tasks; exit 0 |
| Broader-preset attempt | Stopped during startup | 0 | No deployment | Exposed unhandled certificate rejection; fixed |
| Public-feed session after fix | 2 minutes | 210 | No qualifying discovery candidates | 0 queued/active diagnostic tasks; exit 0 |
| Synthetic-market lifecycle session | About 62 seconds | 1,800 | Three open positions; nine closes and redeploys | 0 active Telegram handlers; peak 3 |

Both completed public sessions reported no stalled tasks and no uncaught exceptions. The five-minute session's post-warmup heap ranged from 30.55–34.92 MiB and ended at 31.78 MiB. The post-fix session ranged from 30.59–35.13 MiB and ended at 32.12 MiB. GC was enabled and sampled throughout; these ranges include both ordinary and GC-adjacent samples.

The lifecycle fixture measured approximately 0.81 MiB retained heap growth after GC. Its paper ledger kept three active positions and persisted nine closed outcomes. Command concurrency stayed at three, with queue saturation handled by rejecting excess work. The test returned to zero active handlers.

No infinite queue-drain loop or runaway heap growth was reproduced in these bounded sessions. The initial public session logged 90 non-empty drain events, and the post-fix session logged 30; each ended with zero waiting tasks. These counts reflect queued bursts, not repeated empty drains.

The public sessions generated **no observed trading fees**, because discovery returned no eligible candidates. Synthetic fees and PnL are not market performance. Keep fixture databases as test evidence; do not merge them into live learning. The tests do not establish multiday SDK/RPC stability or profitability.

## Evidence and checks

- Combined measurements: `logs/high-volume-run-results.json`.
- Initial public diagnostics: `logs/paper-soak-2026-10-13T09-51-29-387Z/`.
- Post-fix public diagnostics: `logs/paper-soak-2026-10-13T10-05-34-921Z/`.
- Final fixture measurements: `logs/paper-fixture-soak-1791885707596/report.json`.
- Automated suite: 243 passed, two opt-in checks skipped.
- Lint, diff whitespace checks, script parsing, and Compose configuration validation passed.

Run `npm start` with Node 24 for the configured persistent paper session, or `npm run paper:soak -- 300` for another isolated five-minute diagnostic session. See [decision rules and deployment](DECISION-RULES-AND-DEPLOYMENT.md) for full controls and Docker instructions.
