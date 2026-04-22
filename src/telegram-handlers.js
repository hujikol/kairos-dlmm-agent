import { log } from "./core/logger.js";
import { closePosition } from "./integrations/meteora.js";
import { escapeHTMLLocal as escapeHTML } from "./core/cycles.js";
import {
  getLearningStats,
  pinLesson,
  unpinLesson,
  rateLesson,
  listLessons,
} from "./core/lessons.js";
import { config } from "./config.js";
import { agentLoop } from "./agent/index.js";
import { stripThink } from "./tools/caveman.js";
import { startPolling, sendHTML, sendMessage, sendMessageDirect, sendChatAction } from "./notifications/telegram.js";
import { _busyState } from "./core/state/scheduler-state.js";
import { setPositionInstruction } from "./core/state/index.js";
import {
  getStatusData,
  getBalanceData,
  getCandidatesData,
  getThresholdsData,
  getPositionsData,
  getSwapAllResult,
  triggerScreen,
} from "./core/shared-handlers.js";
import { buildAsciiTable } from "./core/shared-formatters.js";

// Module-level queue and concurrent handler counter
// _telegramBusyCount tracks active handlers (named + LLM chat), allows parallel processing
const _telegramBusyState = { _count: 0 };
const _telegramQueue = [];

export const _telegramBusy = _telegramBusyState;

const MAX_TELEGRAM_QUEUE = 10;
const MAX_CONCURRENT_TELEGRAM = 3; // max parallel Telegram handlers
const TOKEN_SWAP_MIN_BALANCE = 0.01;

export { MAX_TELEGRAM_QUEUE, TOKEN_SWAP_MIN_BALANCE };

// Shared helper: send a message and swallow send errors (always logs)
async function safeSend(text) {
  try {
    await sendMessage(text);
  } catch (e) {
    log("error", "telegram-handler", "Telegram send failed", { error: e?.message });
  }
}

// Shared helper: send an HTML error message, logs any send failure silently
async function safeSendError(error) {
  try {
    await sendHTML(`<b>Error:</b> <code>${escapeHTML(error?.message || String(error))}</code>`);
  } catch (e) {
    log("error", "telegram-handler", "Telegram send failed", { error: e?.message });
  }
}

// Spawn parallel handlers up to MAX_CONCURRENT_TELEGRAM
// NOTE: cycle busy flags are NOT checked here — queued Telegram messages (notifications,
// chat responses) are lightweight and never start new cycles. Blocking drainage while
// cycles run is what caused the stale queue problem.
// This function is synchronous — call it after any async handler that may have
// added items to the queue. It drains everything it can immediately.
export function drainTelegramQueue() {
  // Synchronously drain as many queued items as concurrency allows.
  // NOTE: telegramHandler itself manages _count (increment on entry, decrement in finally).
  // Do NOT increment/decrement _count here — that caused double-counting, stale queues,
  // and infinite-loop bugs.
  while (_telegramQueue.length > 0) {
    if (_telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM) break;
    const queued = _telegramQueue.shift();
    if (!queued) break;
    // Fire-and-forget — telegramHandler owns _count lifecycle
    // Pass fromDrain=true so drained commands skip the busy-state re-queuing check.
    // Without this, drained commands see _screeningBusy/_managementBusy still true
    // and re-queue themselves, creating an infinite drain→re-queue→drain loop.
    telegramHandler(queued, /* fromDrain */ true).then(() => {
      drainTelegramQueue(); // recurse after handler completes to drain next
    }).catch(() => {
      drainTelegramQueue(); // on error, still drain next
    });
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

// ─── Command handlers (module scope) ──────────────────────────────────────────

async function handleBriefing() {
  try {
    const briefing = await generateBriefing();
    await sendHTML(briefing);
  } catch (e) {
    log("warn", "telegram", `Briefing generation failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
}

async function handleBalance() {
  try {
    const { sol, sol_usd, tokens, total_usd } = await getBalanceData();

    const colWidths = [8, 11, 10];
    const rows = [
      { cells: ["Token", "Balance", "Value"] },
      { cells: ["SOL", sol.toFixed(4), `$${sol_usd.toFixed(2)}`] },
      ...tokens.filter(t => t.symbol !== "SOL" && t.usd > TOKEN_SWAP_MIN_BALANCE).map(t => ({
        cells: [t.symbol.slice(0, 8), t.balance.toString().slice(0, 11), `$${t.usd.toFixed(2)}`],
      })),
    ];

    const table = buildAsciiTable(rows, colWidths);

    await sendHTML(
      `<b>💰 Wallet Balance</b>\n\n` +
      `<pre>${escapeHTML(table)}</pre>\n` +
      `<b>Total:</b> $${total_usd.toFixed(2)}`
    );
  } catch (e) {
    log("warn", "telegram", `Wallet balance failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}

async function handleStatus() {
  try {
    const { wallet, positions, total_positions } = await getStatusData();
    const cur = config.management.solMode ? "◎" : "$";

    const colWidths = [2, 10, 6, 6];
    const rows = [
      { cells: ["ID", "Pair", "PnL", "Value"] },
      ...positions.map((p, i) => ({
        align: ["right", "left", "right", "right"],
        cells: [
          String(i + 1),
          p.pair.slice(0, 10),
          `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`,
          `${cur}${p.total_value_usd}`.slice(0, 6),
        ],
      })),
    ];

    const table = buildAsciiTable(rows, colWidths);
    const posBlock = total_positions > 0 ? `<pre>${escapeHTML(table)}</pre>\n` : "<i>No open positions.</i>\n";
    await sendHTML(
      `<b>📊 Status Report</b>\n\n` +
      posBlock +
      `<b>Wallet:</b> ${wallet.sol.toFixed(4)} SOL ($${wallet.sol_usd})\n` +
      `<b>SOL Price:</b> $${wallet.sol_price}`
    );
  } catch (e) {
    log("warn", "telegram", `Status report failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}

async function handleCandidates() {
  try {
    const { candidates } = await getCandidatesData({ limit: 5 });
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
  } catch (e) {
    log("warn", "telegram", `Candidates fetch failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}

async function handleScreen() {
  triggerScreen();
  await sendHTML("🔍 <b>Manual Screening Started</b>");
}

async function handleSwapAll() {
  try {
    await sendHTML("🔄 <b>Sweeping all tokens to SOL...</b>");
    const result = await getSwapAllResult();
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
  } catch (e) {
    log("warn", "telegram", `Swap-all failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
}

async function handleThresholds() {
  try {
    const { screening, management, performance } = getThresholdsData();
    const s = screening;
    const m = management;

    let msg = "⚙️ *BOT CONFIGURATION*\n\n";

    let sc = "🔍 SCREENING\n";
    sc += "────────────────────\n";
    sc += `fee_aTVL_min    ${s.minFeeActiveTvlRatio}%\n`;
    sc += `organic_min     ${s.minOrganic}\n`;
    sc += `holders_min     ${s.minHolders}\n`;
    sc += `tvl_min         $${(s.minTvl/1000).toFixed(1)}k\n`;
    sc += `vol_min         $${(s.minVolume/1000).toFixed(1)}k\n`;
    sc += `mcap_min        $${((s.minMcap ?? 0)/1000).toFixed(1)}k\n`;
    sc += `mcap_max        $${((s.maxMcap ?? 0)/1000000).toFixed(1)}M\n`;
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

    if (performance) {
      msg += `<i>Stats from ${performance.total_positions_closed} closed positions:</i>\n` +
             `<b>Win Rate:</b> ${performance.win_rate_pct}%  •  <b>Avg PnL:</b> ${performance.avg_pnl_pct}%`;
    }

    await sendHTML(msg);
  } catch (e) {
    log("warn", "telegram", `Thresholds display failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}

async function handlePositions() {
  try {
    const { positions, total_positions } = await getPositionsData();
    if (total_positions === 0) { await sendMessage("No open positions."); return; }
    const cur = config.management.solMode ? "◎" : "$";

    const colWidths = [2, 10, 6, 6, 8];
    const rows = [
      { cells: ["#", "Pair", "Value", "PnL", "Fees"] },
      ...positions.map((p, i) => ({
        align: ["right", "left", "right", "right", "right"],
        cells: [
          String(i + 1),
          p.pair.slice(0, 10),
          `${cur}${p.total_value_usd}`.slice(0, 6),
          `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`,
          `${cur}${p.unclaimed_fees_usd}`.slice(0, 6) + (!p.in_range ? " ⚠️" : ""),
        ],
      })),
    ];

    const table = buildAsciiTable(rows, colWidths);
    await sendHTML(
      `<b>📊 Open Positions (${total_positions})</b>\n\n` +
      `<pre>${escapeHTML(table)}</pre>\n` +
      `<code>/close &lt;n&gt;</code> to close | <code>/set &lt;n&gt; &lt;note&gt;</code> to set instruction`
    );
  } catch (e) {
    log("warn", "telegram", `Positions display failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}

// Returns true if the message was handled
async function handleClose(text) {
  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (!closeMatch) return false;

  try {
    const idx = parseInt(closeMatch[1]) - 1;
    const { positions } = await getMyPositions({ force: true });
    if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return true; }
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
  } catch (e) {
    log("warn", "telegram", `Close command failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
  return true;
}

// Returns true if the message was handled
async function handleSet(text) {
  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (!setMatch) return false;

  try {
    const idx = parseInt(setMatch[1]) - 1;
    const note = setMatch[2].trim();
    const { positions } = await getMyPositions({ force: true });
    if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return true; }
    const pos = positions[idx];
    setPositionInstruction(pos.position, note);
    await sendHTML(`✅ Note set for <b>${escapeHTML(pos.pair)}</b>:\n"<i>${escapeHTML(note)}</i>"`);
  } catch (e) {
    log("warn", "telegram", `Set instruction failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
  return true;
}

// Returns true if the message was handled
async function handleTeach(text) {
  const teachMatch = text.match(/^\/teach\s+(.+)$/i);
  if (!teachMatch) return false;

  try {
    await handleTeachCommand(teachMatch[1].trim(), { sendHTML, escapeHTML });
  } catch (e) {
    log("warn", "telegram", `Teach command failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
  return true;
}

// ─── Free-form LLM chat handler ────────────────────────────────────────────────
async function handleLLMChat(text) {
  const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
  const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
  const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
  const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
  const { content } = await agentLoop(text, config.llm.maxSteps, [], agentRole, agentModel, null, { requireTool: true });
  await sendHTML(`<pre>${escapeHTML(stripThink(content))}</pre>`);
}

// ─── Main Telegram handler (dispatcher) ────────────────────────────────────────
export async function telegramHandler(text, fromDrain = false) {
  log("info", "telegram-handler", `telegramHandler called with: "${text}"${fromDrain ? " (from drain)" : ""}`);

  // Busy check first — if queuing, send queue confirmation and skip acknowledgment
  // When fromDrain=true, skip cycle-busy checks — this command already waited in the
  // queue and must not be re-queued (that causes an infinite drain→queue→drain loop).
  // Only enforce the concurrent handler limit for drained commands.
  const cycleBusy = _busyState._managementBusy || _busyState._screeningBusy;
  const atConcurrencyLimit = _telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM;

  if (!fromDrain && (cycleBusy || atConcurrencyLimit)) {
    sendChatAction("typing").catch(() => {});
    if (_telegramQueue.length < MAX_TELEGRAM_QUEUE) {
      _telegramQueue.push(text);
      await sendMessageDirect(`⏳ Queued. ${_telegramQueue.length} message(s) ahead of yours. I'll respond shortly.`);
    } else {
      await sendMessageDirect(`<b>Queue full.</b> ${MAX_TELEGRAM_QUEUE} messages waiting. Try again shortly.`);
    }
    return;
  }

  // Even drained commands must respect concurrency — re-queue if at limit
  if (fromDrain && atConcurrencyLimit) {
    _telegramQueue.unshift(text); // put it back at the front
    return;
  }

  // Immediate "typing" indicator + acknowledgment
  const cmdAcks = {
    "/briefing":   "📋 Generating morning briefing...",
    "/balance":    "💰 Fetching wallet balance...",
    "/status":     "📊 Fetching status report...",
    "/candidates": "🔍 Screening for top candidates...",
    "/screen":     "🔍 Running screening cycle...",
    "/swap-all":   "🔄 Sweeping all tokens to SOL...",
    "/thresholds": "⚙️ Fetching configuration...",
    "/positions":  "📋 Fetching open positions...",
  };
  const ackMsg = cmdAcks[text] ?? `🧠 Thinking...`;
  sendChatAction("typing").catch(() => {}); // non-blocking — indicator shows immediately
  await sendMessageDirect(ackMsg);

  // Increment concurrent handler count (tracks all active handlers for parallel queue)
  _telegramBusyState._count++;
  try {
    // Dispatch to named handlers (exact-match commands)
    switch (text) {
      case "/briefing":   await handleBriefing(); break;
      case "/balance":    await handleBalance(); break;
      case "/status":     await handleStatus(); break;
      case "/candidates": await handleCandidates(); break;
      case "/screen":     await handleScreen(); break;
      case "/swap-all":   await handleSwapAll(); break;
      case "/thresholds": await handleThresholds(); break;
      case "/positions":  await handlePositions(); break;
      default: {
        // Regex-based handlers — return true if they handled the message
        if (await handleClose(text)) { drainTelegramQueue(); return; }
        if (await handleSet(text)) { drainTelegramQueue(); return; }
        if (await handleTeach(text)) { drainTelegramQueue(); return; }
        // Free-form LLM chat (default)
        await handleLLMChat(text);
        drainTelegramQueue();
        return;
      }
    }
    // Named commands drain the queue in background (don't block the user's response)
    drainTelegramQueue();
  } finally {
    _telegramBusyState._count--;
  }
}

// Start polling — called from index.js after rl is set up
export { startPolling };
