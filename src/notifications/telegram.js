import fs from "fs";
import { log } from "../core/logger.js";
import { USER_CONFIG_PATH } from "../config.js";
import { caveman } from "../tools/caveman.js";
import { config, isDryRun } from "../config.js";
import { addrShort } from "../tools/addrShort.js";
import { PRICE_FORMAT_THRESHOLD, TELEGRAM_MSG_DELAY_MS, TELEGRAM_POLL_TIMEOUT_MS } from "../core/constants.js";
import { escapeHTMLLocal } from "../core/cycle-helpers.js";
import writeFileAtomic from "write-file-atomic";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = String(process.env.TELEGRAM_CHAT_ID || "") || null;
let _offset  = 0;
let _polling = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = String(cfg.telegramChatId);
    }
  } catch (e) {
    log("warn", "telegram", `loadChatId: failed to load — telegram disabled: ${e?.message}`);
  }
}

async function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    await writeFileAtomic(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("error", "telegram", `Failed to persist chatId: ${e?.message ?? e}`);
  }
}

loadChatId();

// ─── Queue System & Rate Limiting ────────────────────────────────
const _outboundQueue = [];
let _isSending = false;

async function processQueue() {
  if (_isSending || _outboundQueue.length === 0) return;
  _isSending = true;

  while (_outboundQueue.length > 0) {
    const task = _outboundQueue.shift();
    try {
      await task();
    } catch (e) {
      log("error", "telegram", `Queue task failed: ${e?.message ?? e}`);
    }
    await sleep(TELEGRAM_MSG_DELAY_MS); // 1.5s delay between messages to respect Telegram limits
  }

  _isSending = false;
}

function enqueueMessage(task) {
  _outboundQueue.push(task);
  processQueue();
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

/**
 * Send a Markdown-formatted message to the registered Telegram chat.
 * Queued with rate limiting (1.5s between messages). Respects DRY_RUN.
 * @param {string} text - Message text (max 4096 chars)
 * @param {string} [parseMode="Markdown"] - Telegram parse mode ("Markdown" or "HTML")
 * @returns {Promise<void>}
 */
export async function sendMessage(text, parseMode = "Markdown") {
  if (!TOKEN || !chatId) { log("warn", "telegram", `sendMessage skipped: TOKEN=${!!TOKEN} chatId=${chatId}`); return; }
  if (isDryRun()) {
    log("debug", "telegram", "DRY_RUN: skipping send", { text: String(text).slice(0, 80) });
    return;
  }
  const finalText = config.cavemanEnabled ? caveman(String(text)) : String(text);
  return new Promise((resolve) => {
    enqueueMessage(async () => {
      try {
        const payload = {
          chat_id: chatId,
          text: finalText.slice(0, 4096),
        };
        if (parseMode) payload.parse_mode = parseMode;

        const res = await fetch(`${BASE}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.text();
          if (res.status === 429) {
            log("error", "telegram", `Rate limited (429). Stalling queue...`);
            await sleep(5000);
          } else {
            log("error", "telegram", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
          }
        }
      } catch (e) {
        log("error", "telegram", `sendMessage failed: ${e?.message ?? e}`);
      }
      resolve();
    });
  });
}

/**
 * Send a message directly to Telegram — bypasses the outbound queue.
 * Used for critical errors when the queue is backed up.
 * @param {string} text - Message text
 * @returns {Promise<void>}
 */
export async function sendMessageDirect(text) {
  if (!TOKEN) { log("warn", "telegram", `sendMessageDirect skipped: TOKEN not set`); return; }
  if (!chatId) { log("warn", "telegram", `sendMessageDirect skipped: chatId not set`); return; }
  if (isDryRun()) {
    log("debug", "telegram", "DRY_RUN: skipping direct send", { text: String(text).slice(0, 80) });
    return;
  }
  const safeText = escapeHTMLLocal(String(text)).slice(0, 4096);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: safeText,
        parse_mode: "HTML",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      log("error", "telegram", `sendMessageDirect failed: ${res.status}`);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      log("error", "telegram", `sendMessageDirect timed out after 8s`);
    } else {
      log("error", "telegram", `sendMessageDirect failed: ${e?.message ?? e}`);
    }
  }
}

/**
 * Send a chat action to Telegram — shows "typing..." indicator to user.
 * Bypasses the outbound queue. 5s timeout.
 * @param {string} action - Telegram action: "typing" | "upload_photo" | "record_video" | "voice_message" | etc.
 * @returns {Promise<void>}
 */
export async function sendChatAction(action = "typing") {
  if (!TOKEN) return;
  if (!chatId) return;
  if (isDryRun()) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${BASE}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {}}

// Re-export drainTelegramQueue from telegram-handlers (avoids circular import in management-cycle)
export { drainTelegramQueue } from "../telegram-handlers.js";

/**
 * Send an HTML-formatted message to the registered Telegram chat.
 * Queued with rate limiting (1.5s between messages). Respects DRY_RUN.
 * @param {string} html - HTML message (max 4096 chars)
 * @returns {Promise<void>}
 */
export async function sendHTML(html) {
  if (!TOKEN || !chatId) { log("warn", "telegram", `sendHTML skipped: TOKEN=${!!TOKEN} chatId=${chatId}`); return; }
  if (isDryRun()) {
    log("debug", "telegram", "DRY_RUN: skipping send", { html: String(html).slice(0, 80) });
    return;
  }
  const finalText = config.cavemanEnabled ? caveman(html) : html;
  return new Promise((resolve) => {
    enqueueMessage(async () => {
      try {
        const res = await fetch(`${BASE}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: finalText.slice(0, 4096),
            parse_mode: "HTML",
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          if (res.status === 429) {
            log("error", "telegram", `Rate limited (429). Stalling queue...`);
            await sleep(5000);
          } else {
            log("error", "telegram", `sendHTML ${res.status}: ${err.slice(0, 100)}`);
          }
        }
      } catch (e) {
        log("error", "telegram", `sendHTML failed: ${e?.message ?? e}`);
      }
      resolve();
    });
  });
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(TELEGRAM_POLL_TIMEOUT_MS) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        // Auto-register first sender as the owner
        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("info", "telegram", `Registered chat ID: ${chatId}`);
          await sendMessage("Connected! I'm your LP agent. Ask me anything or use commands like /status.");
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) {
          log("warn", "telegram", `chatId mismatch: incoming=${incomingChatId} stored=${chatId}`);
          continue;
        }

        log("info", "telegram", `Processing: "${msg.text}" from ${incomingChatId}`);
        await onMessage(msg.text);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("error", "telegram", `Poll error: ${e?.message ?? e}`);
      }
      await sleep(5000);
    }
  }
}

/**
 * Start long-polling the Telegram Bot API for incoming messages.
 * Auto-registers the first sender as the owner (chatId persisted to user-config.json).
 * @param {Function} onMessage - Async callback(msg.text) invoked for each incoming message
 * @returns {void}
 */
export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("info", "telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
/**
 * Send a Telegram notification for a newly deployed position.
 * @param {Object} opts - Deploy details
 * @param {string} opts.pair - Trading pair name (e.g. "SOL/USDC")
 * @param {number} opts.amountSol - SOL amount deployed
 * @param {string} opts.position - Position address
 * @param {string} opts.tx - Transaction signature
 * @param {Object} [opts.priceRange] - { min, max } price range
 * @param {number} [opts.binStep] - Pool bin step
 * @param {number} [opts.baseFee] - Pool base fee percentage
 * @returns {Promise<void>}
 */
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, binStep, baseFee }) {
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < PRICE_FORMAT_THRESHOLD ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < PRICE_FORMAT_THRESHOLD ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  •  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    poolStr +
    `Position: <code>${addrShort(position)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

/**
 * Send a Telegram notification when a position is closed.
 * @param {Object} opts - Close details
 * @param {string} opts.pair - Trading pair name
 * @param {number} opts.pnlUsd - Realized PnL in USD
 * @param {number} opts.pnlPct - Realized PnL percentage
 * @returns {Promise<void>}
 */
export async function notifyClose({ pair, pnlUsd, pnlPct, already_closed }) {
  if (already_closed) {
    await sendHTML(
      `⚠️ <b>Close Failed</b> ${pair}\n` +
      `Position may already be closed or untracked.\n` +
      `Manual inspection recommended on Meteora.`
    );
    return;
  }
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`
  );
}

/**
 * Send a Telegram notification when a token swap is executed.
 * @param {Object} opts - Swap details
 * @param {string} opts.inputSymbol - Input token symbol
 * @param {string} opts.outputSymbol - Output token symbol
 * @param {string|number} opts.amountIn - Amount swapped in
 * @param {string|number} opts.amountOut - Amount received
 * @param {string} opts.tx - Transaction signature
 * @returns {Promise<void>}
 */
export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"}  •  Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

/**
 * Send a Telegram warning when a position goes out of range.
 * @param {Object} opts - OOR details
 * @param {string} opts.pair - Trading pair name
 * @param {number} opts.minutesOOR - Minutes the position has been out of range
 * @returns {Promise<void>}
 */
export async function notifyOutOfRange({ pair, minutesOOR }) {
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
