import { getWalletBalances, getMyPositions, closePosition } from "./integrations/meteora.js";
import { getTopCandidates } from "./screening/discovery.js";
import { runScreeningCycle, escapeHTML } from "./core/orchestration.js";
import { swapAllTokensToSol } from "./integrations/helius.js";
import { generateBriefing } from "./notifications/briefing.js";
import { getLearningStats, pinLesson, unpinLesson, rateLesson, listLessons } from "./core/lessons.js";
import { config } from "./config.js";
import { agentLoop } from "./agent.js";
import { stripThink } from "./tools/caveman.js";
import { startPolling, sendHTML, sendMessage } from "./notifications/telegram.js";
import { _managementBusy, _screeningBusy } from "./core/scheduler.js";
import { rl, buildPrompt } from "./rl-shared.js";

// Module-level queue and busy flag (not shared with index.js)
const _telegramQueue = [];
let busy = false;

const MAX_TELEGRAM_QUEUE = 5;
const TOKEN_SWAP_MIN_BALANCE = 0.01;

export { MAX_TELEGRAM_QUEUE, TOKEN_SWAP_MIN_BALANCE };
export { busy };
export async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

// ─── /teach subcommand handler ─────────────────────────────────────────────────
async function handleTeachCommand(sub, { sendHTML, escapeHTML }) {
  const stats = getLearningStats();
  const pinMatch = sub.match(/^pin\s+(.+)$/i);
  if (pinMatch) {
    const result = pinLesson(pinMatch[1].trim());
    if (result.found) {
      await sendHTML(`📌 Lesson pinned:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
    } else {
      await sendHTML(`Lesson <code>${escapeHTML(pinMatch[1])}</code> not found.`);
    }
    return;
  }

  const unpinMatch = sub.match(/^unpin\s+(.+)$/i);
  if (unpinMatch) {
    const result = unpinLesson(unpinMatch[1].trim());
    if (result.found) {
      await sendHTML(`Lesson unpinned:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
    } else {
      await sendHTML(`Lesson <code>${escapeHTML(unpinMatch[1])}</code> not found.`);
    }
    return;
  }

  const rateMatch = sub.match(/^rate\s+(\S+)\s+(useful|useless)$/i);
  if (rateMatch) {
    const result = rateLesson(rateMatch[1], rateMatch[2].toLowerCase());
    if (result.error) {
      await sendHTML(`<code>${escapeHTML(result.error)}</code>`);
    } else if (result.found) {
      const icon = result.rating === "useful" ? "👍" : "👎";
      await sendHTML(`${icon} Lesson rated as <b>${result.rating}</b>:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
    } else {
      await sendHTML(`Lesson <code>${escapeHTML(rateMatch[1])}</code> not found.`);
    }
    return;
  }

  if (/^stats$/i.test(sub)) {
    let msg = `<b>Learning System Status</b>\n\n`;
    msg += `Closed positions: <b>${stats.performance_records}</b>\n`;
    msg += `Near-miss records: <b>${stats.near_misses}</b>\n`;
    msg += `Total lessons: <b>${stats.total_lessons}</b>\n`;
    msg += `Archived records: <b>${stats.archived_records}</b>\n`;
    if (stats.overall_win_rate != null) msg += `\nWin rate: <b>${stats.overall_win_rate}%</b>\n`;
    if (stats.total_pnl_usd != null) msg += `Total PnL: <b>$${stats.total_pnl_usd}</b>\n`;
    if (stats.avg_pnl_pct != null) msg += `Avg PnL: <b>${stats.avg_pnl_pct}%</b>\n`;
    if (stats.near_miss_avg_pnl_pct != null) msg += `Near-miss avg PnL: <b>${stats.near_miss_avg_pnl_pct}%</b>\n`;
    msg += `\nPinned: ${stats.pinned_lessons} | Useful: ${stats.rated_useful} | Useless: ${stats.rated_useless}\n`;
    msg += `Evolution cycles: ${stats.evolution_cycles}\n`;
    if (stats.current_thresholds && Object.keys(stats.current_thresholds).length > 0) {
      msg += `\n<b>Current thresholds:</b>\n`;
      msg += `maxBinStep: ${stats.current_thresholds.maxBinStep}\n`;
      msg += `minFeeActiveTvlRatio: ${stats.current_thresholds.minFeeActiveTvlRatio}\n`;
      msg += `minOrganic: ${stats.current_thresholds.minOrganic}`;
    }
    await sendHTML(msg);
    return;
  }

  if (/^list/i.test(sub)) {
    const roleArg = sub.split(/\s+/)[1]?.toUpperCase() || null;
    const result = listLessons({ role: roleArg, limit: 15 });
    if (result.total === 0) { await sendHTML("No lessons found."); return; }
    let msg = `<b>Lessons</b> (${result.total} total, showing ${result.lessons.length})\n\n`;
    for (const l of result.lessons) {
      const pinIcon = l.pinned ? "📌" : "";
      msg += `<code>${escapeHTML(l.id.slice(0, 8))}</code> ${pinIcon}[${l.outcome}] ${escapeHTML(l.rule.slice(0, 60))}\n`;
    }
    msg += `\n<i>Use /teach pin|rate|stats to manage</i>`;
    await sendHTML(msg);
    return;
  }

  await sendHTML(`<b>/teach</b> subcommands:\n<pre>  pin &lt;id&gt;       — pin a lesson\n  unpin &lt;id&gt;     — unpin a lesson\n  rate &lt;id&gt; useful|useless  — rate a lesson\n  stats          — learning system status\n  list [role]    — list lessons (optionally by role)</pre>`);
}

// ─── Main Telegram handler ─────────────────────────────────────────────────────
export async function telegramHandler(text) {
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < MAX_TELEGRAM_QUEUE) {
      _telegramQueue.push(text);
      sendHTML(`⏳ <b>Queued</b> (${_telegramQueue.length} in queue): "<i>${escapeHTML(text.slice(0, 60))}</i>"`).catch(() => {});
    } else {
      sendHTML(`Queue is full (${MAX_TELEGRAM_QUEUE} messages). Wait for the agent to finish.`).catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/balance") {
    try {
      const wallet = await getWalletBalances();
      const cur = config.management.solMode ? "◎" : "$";

      let table = "Token     Balance      Value\n";
      table += "────────  ───────────  ──────\n";

      table += `SOL       ${wallet.sol.toFixed(4).padEnd(11)}  $${wallet.sol_usd.toFixed(2)}\n`;

      wallet.tokens.filter(t => t.symbol !== "SOL" && t.usd > TOKEN_SWAP_MIN_BALANCE).forEach(t => {
        const sym = t.symbol.slice(0, 8).padEnd(8);
        const bal = t.balance.toString().slice(0, 11).padEnd(11);
        const val = `$${t.usd.toFixed(2)}`;
        table += `${sym}  ${bal}  ${val}\n`;
      });

      await sendHTML(
        `<b>💰 Wallet Balance</b>\n\n` +
        `<pre>${escapeHTML(table)}</pre>\n` +
        `<b>Total:</b> $${wallet.total_usd.toFixed(2)}`
      );
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/status") {
    try {
      const [wallet, positionsData] = await Promise.all([
        getWalletBalances(),
        getMyPositions({ force: true })
      ]);
      const { positions, total_positions } = positionsData;
      const cur = config.management.solMode ? "◎" : "$";

      let table = "ID  Pair        PnL     Value\n";
      table += "──  ──────────  ──────  ──────\n";
      positions.forEach((p, i) => {
        const pair = p.pair.slice(0, 10).padEnd(10);
        const pnl = `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`.padEnd(6);
        const val = `${cur}${p.total_value_usd}`.padEnd(6);
        table += `${String(i + 1).padEnd(2)}  ${pair}  ${pnl}  ${val}\n`;
      });

      const posBlock = total_positions > 0 ? `<pre>${escapeHTML(table)}</pre>\n` : "<i>No open positions.</i>\n";
      await sendHTML(
        `<b>📊 Status Report</b>\n\n` +
        posBlock +
        `<b>Wallet:</b> ${wallet.sol.toFixed(4)} SOL ($${wallet.sol_usd})\n` +
        `<b>SOL Price:</b> $${wallet.sol_price}`
      );
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/candidates") {
    try {
      const { candidates } = await getTopCandidates({ limit: 5 });
      if (!candidates?.length) { await sendMessage("No candidates found."); return; }

      let table = "#   Pool        fee/TVL  vol    org\n";
      table += "──  ──────────  ───────  ─────  ───\n";
      candidates.forEach((p, i) => {
        const name = p.name.slice(0, 10).padEnd(10);
        const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.slice(0, 5).padStart(7);
        const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(5);
        const org = String(p.organic_score).padStart(3);
        table += `${String(i + 1).padEnd(2)}  ${name}  ${ftvl}  ${vol}  ${org}\n`;
      });

      await sendHTML(`<b>🔍 Top Candidates</b>\n\n<pre>${escapeHTML(table)}</pre>`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/screen") {
    runScreeningCycle().catch((e) => { /* log in orchestration */ });
    await sendHTML("🔍 <b>Manual Screening Started</b>");
    return;
  }

  if (text === "/swap-all") {
    try {
      await sendHTML("🔄 <b>Sweeping all tokens to SOL...</b>");
      const result = await swapAllTokensToSol();
      if (result.success) {
        const count = result.swapped?.length || 0;
        if (count === 0) {
          await sendHTML("No eligible tokens found to swap.");
        } else {
          const symbols = result.swapped.map(s => s.input_mint?.slice(0, 4)).join(", ");
          await sendHTML(`✅ <b>Sweep Complete</b>\nSwapped ${count} tokens (<code>${escapeHTML(symbols)}</code>) to SOL.`);
        }
      } else {
        await sendHTML(`❌ Sweep failed: <code>${escapeHTML(result.error)}</code>`);
      }
    } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  if (text === "/thresholds") {
    try {
      const s = config.screening;
      const m = config.management;
      const perf = (await import("./core/lessons.js")).getPerformanceSummary();

      let msg = "⚙️ *BOT CONFIGURATION*\n\n";

      let sc = "🔍 SCREENING\n";
      sc += "────────────────────\n";
      sc += `fee_aTVL_min    ${s.minFeeActiveTvlRatio}%\n`;
      sc += `organic_min     ${s.minOrganic}\n`;
      sc += `holders_min     ${s.minHolders}\n`;
      sc += `tvl_min         $${(s.minTvl/1000).toFixed(1)}k\n`;
      sc += `vol_min         $${(s.minVolume/1000).toFixed(1)}k\n`;
      sc += `mcap_min        $${(s.minMcap/1000).toFixed(1)}k\n`;
      sc += `mcap_max        $${(s.maxMcap/1000000).toFixed(1)}M\n`;
      sc += `age_min         ${s.minTokenAgeHours ?? 0}h\n`;
      sc += `timeframe       ${s.timeframe}\n`;
      msg += "```\n" + sc + "```\n";

      let mg = "💼 MANAGEMENT\n";
      mg += "────────────────────\n";
      mg += `deploy_amt      ${m.deployAmountSol} SOL\n`;
      mg += `max_pos         ${m.maxPositions}\n`;
      mg += `min_open        ${m.minSolToOpen} SOL\n`;
      mg += `gas_reserve     ${m.gasReserve} SOL\n`;
      mg += `strategy        ${m.strategy}\n`;
      msg += "```\n" + mg + "```\n";

      let rs = "🛡️ RISK & EXIT\n";
      rs += "────────────────────\n";
      rs += `stop_loss       ${m.stopLossPct}%\n`;
      rs += `tp_fee_pct      ${m.takeProfitFeePct}%\n`;
      rs += `trailing_tp     ${m.trailingTakeProfit ? "ON" : "OFF"}\n`;
      rs += `  trigger       ${m.trailingTriggerPct}%\n`;
      rs += `  drop          ${m.trailingDropPct}%\n`;
      rs += `oor_wait        ${m.outOfRangeWaitMinutes}m\n`;
      msg += "```\n" + rs + "```\n";

      if (perf) {
        msg += `<i>Stats from ${perf.total_positions_closed} closed positions:</i>\n` +
               `<b>Win Rate:</b> ${perf.win_rate_pct}%  •  <b>Avg PnL:</b> ${perf.avg_pnl_pct}%`;
      }

      await sendHTML(msg);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";

      let table = "#   Pair        Value   PnL     Fees\n";
      table += "──  ──────────  ──────  ──────  ──────\n";
      positions.forEach((p, i) => {
        const pair = p.pair.slice(0, 10).padEnd(10);
        const val = `${cur}${p.total_value_usd}`.slice(0, 6).padEnd(6);
        const pnl = `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`.slice(0, 6).padEnd(6);
        const fees = `${cur}${p.unclaimed_fees_usd}`.slice(0, 6).padEnd(6);
        const oor = !p.in_range ? " ⚠️" : "";
        table += `${String(i + 1).padEnd(2)}  ${pair}  ${val}  ${pnl}  ${fees}${oor}\n`;
      });

      await sendHTML(
        `<b>📊 Open Positions (${total_positions})</b>\n\n` +
        `<pre>${escapeHTML(table)}</pre>\n` +
        `<code>/close &lt;n&gt;</code> to close | <code>/set &lt;n&gt; &lt;note&gt;</code> to set instruction`
      );
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return; }
      const pos = positions[idx];
      await sendHTML(`Closing <b>${escapeHTML(pos.pair)}</b>...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: <code>${escapeHTML(result.claim_txs.join(", "))}</code>` : "";
        await sendHTML(`✅ <b>Closed</b> ${escapeHTML(pos.pair)}\n<b>PnL:</b> ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"}  •  <b>txs:</b> <code>${escapeHTML(closeTxs?.join(", ") || "n/a")}</code>${claimNote}`);
      } else {
        await sendHTML(`❌ Close failed: <code>${escapeHTML(JSON.stringify(result))}</code>`);
      }
    } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return; }
      const pos = positions[idx];
      const { setPositionInstruction } = await import("./core/state.js");
      setPositionInstruction(pos.position, note);
      await sendHTML(`✅ Note set for <b>${escapeHTML(pos.pair)}</b>:\n"<i>${escapeHTML(note)}</i>"`);
    } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  const teachMatch = text.match(/^\/teach\s+(.+)$/i);
  if (teachMatch) {
    try {
      await handleTeachCommand(teachMatch[1].trim(), { sendHTML, escapeHTML });
    } catch (e) { await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  // Free-form LLM chat
  busy = true;
  try {
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    const { content } = await agentLoop(text, config.llm.maxSteps, [], agentRole, agentModel, null, { requireTool: true });
    await sendHTML(`<pre>${escapeHTML(stripThink(content))}</pre>`);
  } catch (e) {
    await sendHTML(`<b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
  } finally {
    busy = false;
    drainTelegramQueue().catch(() => {});
  }
}

// Start polling — called from index.js after rl is set up
export { startPolling };
