import { queuedTask, diagnostic } from "../core/diagnostics.js";
import { log } from "../core/logger.js";
import { _busyState } from "../core/state/scheduler-state.js";
import { startPolling as startTelegramPolling, stopPolling as stopTelegramPolling, sendHTML, sendMessage, sendMessageDirect, sendChatAction, sendRichMessage } from "../notifications/telegram.js";
import { agentLoop } from "../agent/index.js";
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
  handleSafeModeCommand,
} from "./commands/index.js";

// Module-level queue and concurrent handler counter
// _telegramBusyCount tracks active handlers (named + LLM chat), allows parallel processing
const _telegramBusyState = { _count: 0 };
const _telegramQueue = [];

export const _telegramBusy = _telegramBusyState;

const MAX_TELEGRAM_QUEUE = 10;
const MAX_CONCURRENT_TELEGRAM = 3; // max parallel Telegram handlers
const TOKEN_SWAP_MIN_BALANCE = 0.01;
const READ_ONLY_COMMANDS = ['/balance', '/status', '/positions', '/thresholds'];

export { MAX_TELEGRAM_QUEUE, TOKEN_SWAP_MIN_BALANCE };

// Shared helper: send a message and swallow send errors (always logs)
export async function safeSend(text) {
  try {
    await sendMessage(text);
  } catch (e) {
    log("error", "telegram-handler", "Telegram send failed", { error: e?.message });
  }
}

function isReadOnlyCommand(text) {
  return READ_ONLY_COMMANDS.includes(text);
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
  if (_drainingScheduled || _telegramQueue.length === 0 || _telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM || _busyState._managementBusy || _busyState._screeningBusy) return; // drain already scheduled — it will run shortly
  _drainingScheduled = true;
  setImmediate(() => {
    _drainingScheduled = false;
    if (_busyState._managementBusy || _busyState._screeningBusy) return;
    diagnostic("telegram_drain", { depth: _telegramQueue.length, activeHandlers: _telegramBusyState._count });
    while (_telegramQueue.length > 0) {
      if (_telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM) break;
      const queued = _telegramQueue.shift();
      if (!queued) break;
      queued().catch(e => log("error", "telegram-handler", `Queued command failed: ${e?.message ?? e}`));
    }
  });
}

// ─── Free-form LLM chat handler ────────────────────────────────────────────────
async function handleLLMChat(text) {
  const { content } = await agentLoop(text);
  await sendRichMessage(content);
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

  try {
    await sendMessageDirect(ackMsg);
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
      case "/safe-mode":  await handleSafeModeCommand(text.slice("/safe-mode".length).trim().split(/\s+/).filter(Boolean), safeSend); break;
      default: {
        // Regex-based handlers — return true if they handled the message
        if (/^\/rules(?:\s|$)/.test(text)) {
          const { getActiveRules, getRuleHistory, updateRules, rollbackRules } = await import("../core/rule-memory.js");
          const sub = text.slice(6).trim();
          const result = sub === "update" ? await updateRules() : sub === "rollback" ? rollbackRules() : sub === "history" ? getRuleHistory() : getActiveRules();
          await safeSend(JSON.stringify(result, null, 2));
          return;
        }
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
  const isReadOnly = isReadOnlyCommand(text);
  if (_telegramBusyState._count >= MAX_CONCURRENT_TELEGRAM || (!isReadOnly && (_busyState._managementBusy || _busyState._screeningBusy))) {
    sendChatAction("typing").catch(() => {});
    if (_telegramQueue.length < MAX_TELEGRAM_QUEUE) {
      _telegramQueue.push(queuedTask("telegram_inbound", () => processTelegramMessage(text)));
      diagnostic("queue_depth", { source: "telegram_inbound", depth: _telegramQueue.length, activeHandlers: _telegramBusyState._count, managementBusy: _busyState._managementBusy, screeningBusy: _busyState._screeningBusy });
      await sendMessageDirect(`⏳ Queued. ${_telegramQueue.length} message(s) ahead of yours. I'll respond shortly.`);
    } else {
      diagnostic("queue_full", { source: "telegram_inbound", depth: _telegramQueue.length });
      await sendMessageDirect(`<b>Queue full.</b> ${MAX_TELEGRAM_QUEUE} messages waiting. Try again shortly.`);
    }
    return;
  }

  await queuedTask("telegram_inbound", () => processTelegramMessage(text))();
}

// Start polling — called from index.js after rl is set up
export function startPolling(onMessage) {
  startTelegramPolling(onMessage);
}

export function stopPolling() {
  stopTelegramPolling();
}
