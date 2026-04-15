import "dotenv/config";
import readline from "readline";

import { agentLoop } from "./agent/index.js";
import { log } from "./core/logger.js";
import { config, isDryRun } from "./config.js";
import {
  timers,
  startCronJobs,
  stopCronJobs,
  nextRunIn,
  formatCountdown,
  maybeRunMissedBriefing,
} from "./core/scheduler.js";
import { stopPolling } from "./notifications/telegram.js";
import { runScreeningCycle } from "./core/cycles.js";
import { getMyPositions } from "./integrations/meteora.js";
import { initSentry } from "./instrument.js";
import { registerCronRestarter } from "./tools/executor.js";
import { createHealthServer, startHealthServer } from "./server/health.js";
import { setHealthServer, setPromptRefreshInterval, shutdown } from "./server/shutdown.js";

// Imports from extracted files
import { telegramHandler, startPolling, drainTelegramQueue, busy } from "./telegram-handlers.js";
import { runStartupFetch, setupReplLineHandler, launchCron, cronStarted } from "./repl.js";
import { swapAllTokensToSol } from "./integrations/helius.js";
import { setRl, buildPrompt } from "./rl-shared.js";

// Initialize Sentry after config loads
initSentry();

log("info", "startup", "DLMM LP Agent starting...");
log("info", "startup", `Mode: ${isDryRun() ? "DRY RUN" : "LIVE"}`);
log("info", "startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

// ─── Health endpoint (process liveness probe) ───────────────────────────────────
const healthServer = createHealthServer();
startHealthServer(healthServer);
setHealthServer(healthServer);

// ─── Shutdown ─────────────────────────────────────────────────────────────────

// ─── Cron restarter ───────────────────────────────────────────────────────────
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

// ─── REPL & Telegram ───────────────────────────────────────────────────────────
const isTTY = process.stdin.isTTY;

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  setRl(rl); // share rl with telegram-handlers.js

  // Update prompt countdown every 10 seconds
  const _promptRefreshInterval = setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }, 10_000);

  setPromptRefreshInterval(_promptRefreshInterval);

  // Start autonomous cycles immediately on launch
  launchCron();
  runStartupFetch().catch(e => log("error", "startup", `Startup fetch failed: ${e.message}`));

  // Wire up REPL slash commands
  setupReplLineHandler(buildPrompt, shutdown, runScreeningCycle, swapAllTokensToSol);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy into that pool
  auto           Let the agent pick and deploy automatically
  screen         Manually trigger screening cycle
  /swap-all      Sweep all tokens to SOL
  go             Start cron cycles without deploying
  /stop          Shutdown
  /status        Show wallet and positions
  /balance       Show wallet holdings
  /briefing      Show morning briefing
  /candidates    Refresh top pool candidates
  /thresholds    Show screening thresholds
  /learn [pool]  Study top LPers
  /evolve        Evolve thresholds from performance data
`);

  rl.prompt();

} else {
  // Non-TTY: start immediately
  log("info", "startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${config.management.deployAmountSol} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("error", "startup", e.message);
    }
  })();
}

// Start Telegram polling (rl is set above in the TTY block)
startPolling(telegramHandler);