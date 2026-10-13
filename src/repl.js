import { queuedTask, diagnostic } from "./core/diagnostics.js";
import { agentLoop } from "./agent/index.js";
import { log } from "./core/logger.js";
import { getWalletBalances } from "./integrations/helius.js";
import { getMyPositions } from "./integrations/meteora.js";
import { getTopCandidates } from "./screening/discovery.js";
import { config } from "./config.js";
import { startCronJobs } from "./core/scheduler.js";
import { startWatchdog } from "./watchdog.js";
import { generateBriefing } from "./notifications/briefing.js";
import { rl } from "./rl-shared.js";
import { _telegramBusy, drainTelegramQueue } from "./telegram/index.js";
import {
  getStatusData,
  getBalanceData,
  getCandidatesData,
  getThresholdsData,
  triggerScreen,
  getSwapAllResult,
} from "./core/shared-handlers.js";
import { formatCandidates, formatBalance, formatPositions } from "./core/shared-formatters.js";

// ─── Module-level state ─────────────────────────────────────────────────────────
const sessionHistory = [];
const MAX_HISTORY = 20;
let startupCandidates = [];
export let cronStarted = false;

// ─── Cron launcher ─────────────────────────────────────────────────────────────
export function launchCron() {
  if (!cronStarted) {
    cronStarted = true;
    startCronJobs();
    startWatchdog(config).catch(e => log("error", "startup", `Watchdog failed to start: ${e?.message ?? String(e)}`));
    console.log("Autonomous cycles are now running.\n");
  }
}

// ─── REPL busy guard ───────────────────────────────────────────────────────────
export async function runBusy(fn) {
  if (_telegramBusy._count > 0) { diagnostic("repl_busy_rejected", { activeHandlers: _telegramBusy._count }); console.log("Agent is busy, please wait..."); return; }
  _telegramBusy._count++;
  try { await queuedTask("repl", fn)(); }
  catch (e) { log("warn", "repl", `REPL error: ${e?.message ?? e}`); }
  finally { _telegramBusy._count--; drainTelegramQueue(); }
}

// ─── Session history ────────────────────────────────────────────────────────────
export function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}


// ─── Startup fetch ─────────────────────────────────────────────────────────────
export async function runStartupFetch() {
  console.log(`\n╔═══════════════════════════════════════════╗\n║         DLMM LP Agent — Ready             ║\n╚═══════════════════════════════════════════╝\n`);
  console.log("Fetching wallet and top pool candidates...\n");

  _telegramBusy._count++;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);
    startupCandidates = candidates;
    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);
    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }
    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));
  } catch (e) {
    try { (await import("./instrument.js")).captureError(e, { phase: "startup" }).catch(err => log("warn", "startup", `Sentry capture failed: ${err?.message ?? String(err)}`)); } catch (_) {}
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    _telegramBusy._count--;
    drainTelegramQueue();
  }
  return startupCandidates;
}

// ─── REPL line handler ─────────────────────────────────────────────────────────
export function setupReplLineHandler(buildPrompt, shutdown, runScreeningCycle, swapAllTokensToSol) {
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Number pick: deploy into pool N
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= (startupCandidates?.length || 0)) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${config.management.deployAmountSol} SOL into ${pool.name}...\n`);
        const reply = await runScreeningCycle({ poolAddress: pool.pool });
        console.log(`\n${reply || "No deployment passed the rules."}\n`);
        launchCron();
      });
        startupCandidates = [];
      return;
    }

    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        const reply = await runScreeningCycle();
        console.log(`\n${reply || "No deployment passed the rules."}\n`);
        launchCron();
      });
      return;
    }

    if (input.toLowerCase() === "screen" || input.toLowerCase() === "/screen") {
      triggerScreen();
      console.log("\nManual screening cycle started.\n");
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === "/swap-all") {
      await runBusy(async () => {
        console.log("\nSweeping wallet to SOL...\n");
        const result = await getSwapAllResult();
        console.log(result.success
          ? `\nSweep complete. Swapped ${result.swapped?.length || 0} tokens.\n`
          : `\nSweep failed: ${result.error}\n`);
      });
      return;
    }

    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const { wallet, positions, total_positions } = await getStatusData();
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${total_positions}`);
        console.log(formatPositions(positions, "terminal", config.management.solMode));
        console.log();
      });
      return;
    }

    if (input === "/balance") {
      await runBusy(async () => {
        const data = await getBalanceData();
        console.log(formatBalance(data, "terminal"));
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getCandidatesData({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const { screening, performance } = getThresholdsData();
      const s = screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      if (performance) {
        console.log(`\n  Based on ${performance.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${performance.win_rate_pct}%  |  Avg PnL: ${performance.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "/evolve" || /^\/rules(?:\s|$)/.test(input)) {
      await runBusy(async () => {
        const { updateRules, getActiveRules, getRuleHistory, rollbackRules } = await import("./core/rule-memory.js");
        const sub = input === "/evolve" ? "update" : input.slice(6).trim();
        const result = sub === "update" ? await updateRules() : sub === "history" ? getRuleHistory() : sub === "rollback" ? rollbackRules() : getActiveRules();
        console.log(JSON.stringify(result, null, 2));
      });
      return;
    }

    // Free-form chat
    await runBusy(async () => {
      log("info", "user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { requireTool: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));
}