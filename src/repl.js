import { agentLoop } from "./agent/index.js";
import { log } from "./core/logger.js";
import { getWalletBalances } from "./integrations/helius.js";
import { getMyPositions } from "./integrations/meteora.js";
import { getTopCandidates } from "./screening/discovery.js";
import { config, reloadScreeningThresholds } from "./config.js";
import { startCronJobs } from "./core/scheduler.js";
import { startWatchdog } from "./watchdog.js";
import { generateBriefing } from "./notifications/briefing.js";
import { evolveThresholds, getPerformanceSummary } from "./core/lessons.js";
import { getDB } from "./core/db.js";
import { rl } from "./rl-shared.js";
import { _telegramBusy } from "./telegram-handlers.js";
import {
  getStatusData,
  getBalanceData,
  getCandidatesData,
  getThresholdsData,
  triggerScreen,
  getSwapAllResult,
} from "./core/shared-handlers.js";

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
  if (_telegramBusy._count > 0) { console.log("Agent is busy, please wait..."); return; }
  _telegramBusy._count++;
  try { await fn(); }
  catch (e) { log("warn", "repl", `REPL error: ${e?.message ?? e}`); }
  finally { _telegramBusy._count--; }
}

// ─── Session history ────────────────────────────────────────────────────────────
export function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// ─── formatCandidates (moved from index.js) ───────────────────────────────────
export function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";
  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });
  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
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
  } catch (_e) {
    try { (await import("./instrument.js")).captureError(_e, { phase: "startup" }).catch(_err => log("warn", "startup", `Sentry capture failed: ${_err?.message || _err}`)); } catch (_err2) { log("warn", "startup", `startup fetch failed: ${_err2?.message || _err2}`); }
    console.error(`Startup fetch failed: ${_e.message}`);
  } finally {
    _telegramBusy._count--;
  }
  return startupCandidates;
}

// ─── REPL line handler ─────────────────────────────────────────────────────────
export function setupReplLineHandler(_buildPrompt, _shutdown, _runScreeningCycle, _swapAllTokensToSol) {
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Number pick: deploy into pool N
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${config.management.deployAmountSol} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${config.management.deployAmountSol} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps, [], "SCREENER", null, null, { requireTool: true }
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${config.management.deployAmountSol} SOL. Execute now, don't ask.`,
          config.llm.maxSteps, [], "SCREENER", null, null, { requireTool: true }
        );
        console.log(`\n${reply}\n`);
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
        for (const p of positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/balance") {
      await runBusy(async () => {
        const { sol, sol_usd, tokens, total_usd } = await getBalanceData();
        console.log(`\nWallet Holdings ($${total_usd.toFixed(2)}):`);
        console.log(`  SOL:   ${sol.toFixed(4)} ($${sol_usd.toFixed(2)})`);
        for (const t of tokens) {
          if (t.symbol !== "SOL" && t.usd > 0.01) {
            console.log(`  ${t.symbol.padEnd(6)}: ${t.balance.toString().padEnd(12)} ($${t.usd.toFixed(2)})`);
          }
        }
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

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;
        let poolsToStudy = [];
        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) { console.log("No eligible pools found to study.\n"); return; }
          poolsToStudy = candidates.map(c => ({ pool: c.pool, name: c.name }));
        }
        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();
        const poolList = poolsToStudy.map((p, i) => `${i + 1}. ${p.name} (${p.pool})`).join("\n");
        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:\n\n${poolList}\n\nFor each pool, call study_top_lpers then move to the next. After studying all pools:\n1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).\n2. Note pool-specific patterns where behaviour differs significantly.\n3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.\n4. Summarize what you learned.\n\nFocus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps, [], "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = await getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const db = getDB();
        const allPerformance = db.prepare('SELECT * FROM performance').all();
        const result = evolveThresholds(allPerformance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, _val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
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