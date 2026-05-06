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

// Spawn queued handlers up to MAX_CONCURRENT_TELEGRAM once cycles are idle.
let _drainingScheduled = false;
export function drainTelegramQueue() {
  if (_drainingScheduled) return; // drain already scheduled — it will run shortly
  _drainingScheduled = true;
  setImmediate(() => {
    _drainingScheduled = false;
    if (_busyState._managementBusy || _busyState._screeningBusy) return;
    while (_telegramQueue.length > 0) {
      if (_telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM) break;
      const queued = _telegramQueue.shift();
      if (!queued) break;
      processTelegramMessage(queued).catch(() => {
        // Error is already logged inside telegramHandler
      });
    }
  });
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

async function processTelegramMessage(text) {
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

  // Reserve the slot before any await so queue drainage honors the cap.
  _telegramBusyState._count++;
  sendChatAction("typing").catch(() => {}); // non-blocking — indicator shows immediately
  await sendMessageDirect(ackMsg);

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
        if (await handleClose(text)) return;
        if (await handleSet(text)) return;
        if (await handleTeach(text)) return;
        if (await handleLearn(text)) return;
        // Free-form LLM chat (default)
        await handleLLMChat(text);
        return;
      }
    }
    // Named commands complete — the finally block below schedules the next queued item.
  } finally {
    _telegramBusyState._count--;
    drainTelegramQueue();
  }
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

  await processTelegramMessage(text);
}

// Start polling — called from index.js after rl is set up
export function startPolling(onMessage) {
  startTelegramPolling(onMessage);
}

export function stopPolling() {
  stopTelegramPolling();
}
