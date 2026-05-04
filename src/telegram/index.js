import { log } from "../core/logger.js";
import { config } from "../config.js";
import { _busyState } from "../core/state/scheduler-state.js";
import { startPolling as startTelegramPolling, stopPolling as stopTelegramPolling, sendHTML, sendMessage, sendMessageDirect, sendChatAction } from "../notifications/telegram.js";
import { stripThink } from "../tools/caveman.js";
import { agentLoop } from "../agent/index.js";
import { rl, buildPrompt } from "../rl-shared.js";
import { escapeHTMLLocal } from "../core/cycle-helpers.js";

// Import all command handlers
import {
  handleBriefing,
  handleBalance,
  handleStatus,
  handleCandidates,
  handleScreen,
  handleSwapAll,
  handleThresholds,
  handlePositions,
  handleClose,
  handleSet,
  handleTeach,
  handleCaveman,
  handleLearn,
} from "./commands/index.js";

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
export async function safeSend(text) {
  try {
    await sendMessage(text);
  } catch (e) {
    log("error", "telegram-handler", "Telegram send failed", { error: e?.message });
  }
}

// Shared helper: send an HTML error message, logs any send failure silently
export async function safeSendError(error) {
  try {
    await sendHTML(`<b>Error:</b> <code>${escapeHTMLLocal(error?.message || String(error))}</code>`);
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
    telegramHandler(queued).then(() => {
      drainTelegramQueue(); // recurse after handler completes to drain next
    }).catch(() => {
      drainTelegramQueue(); // on error, still drain next
    });
  }
}

// ─── Free-form LLM chat handler ────────────────────────────────────────────────
async function handleLLMChat(text) {
  const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
  const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
  const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
  const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
  const { content } = await agentLoop(text, config.llm.maxSteps, [], agentRole, agentModel, null, { requireTool: true });
  await sendHTML(`<pre>${stripThink(content)}</pre>`);
}

// ─── Main Telegram handler (dispatcher) ────────────────────────────────────────
export async function telegramHandler(text) {
  log("info", "telegram-handler", `telegramHandler called with: "${text}"`);

  // Busy check first — if queuing, send queue confirmation and skip acknowledgment
  if (_busyState._managementBusy || _busyState._screeningBusy || _telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM) {
    sendChatAction("typing").catch(() => {});
    if (_telegramQueue.length < MAX_TELEGRAM_QUEUE) {
      _telegramQueue.push(text);
      await sendMessageDirect(`⏳ Queued. ${_telegramQueue.length} message(s) ahead of yours. I'll respond shortly.`);
    } else {
      await sendMessageDirect(`<b>Queue full.</b> ${MAX_TELEGRAM_QUEUE} messages waiting. Try again shortly.`);
    }
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
    "/caveman":    "🗣 Toggling caveman mode...",
    "/learn":      "🧠 Studying top LPers...",
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
      case "/caveman":    await handleCaveman(); break;
      case "/learn":      await handleLearn("/learn"); break;
      default: {
        // Regex-based handlers — return true if they handled the message
        if (await handleClose(text)) { drainTelegramQueue(); return; }
        if (await handleSet(text)) { drainTelegramQueue(); return; }
        if (await handleTeach(text)) { drainTelegramQueue(); return; }
        if (await handleLearn(text)) { drainTelegramQueue(); return; }
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
export function startPolling(onMessage) {
  startTelegramPolling(onMessage);
}

export function stopPolling() {
  stopTelegramPolling();
}
