// Run: node --experimental-test-module-mocks --test test/telegram-queue.check.mjs
import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("rich-message fallback drains when another send arrives during an active task", { timeout: 3000 }, async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  process.env.KAIROS_DIAGNOSTICS = "false";
  const stub = (relative, namedExports) => mock.module(new URL(relative, import.meta.url).href, { namedExports });
  stub("../src/core/logger.js", { log() {} });
  stub("../src/tools/caveman.js", { caveman: s => s });
  stub("../src/config.js", { config: { cavemanEnabled: false }, isDryRun: () => false });
  stub("../src/core/state/registry.js", { getKV: () => "test-chat", setKV() {} });
  stub("../src/tools/addrShort.js", { addrShort: s => s });
  stub("../src/core/constants.js", { PRICE_FORMAT_THRESHOLD: 0.01, TELEGRAM_MSG_DELAY_MS: 1, TELEGRAM_POLL_TIMEOUT_MS: 100 });
  stub("../src/core/cycle-helpers.js", { escapeHTMLLocal: s => s });
  stub("../src/telegram/index.js", { drainTelegramQueue() {} });
  const calls = [];
  let release;
  mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(options.body) });
    if (url.endsWith("/sendRichMessage")) {
      await new Promise(r => { release = r; });
      return { ok: false, status: 404, text: async () => "unsupported" };
    }
    return { ok: true };
  });
  try {
    const { sendRichMessage, sendMessage } = await import("../src/notifications/telegram.js");
    const first = sendRichMessage("**first**");
    assert.equal(typeof release, "function");
    const second = sendMessage("second");
    assert.equal(calls.length, 1, "second must wait while first holds worker");
    release();
    await Promise.all([first, second]);
    assert.deepEqual(calls.map(c => c.method), ["sendRichMessage", "sendMessage", "sendMessage"]);
    assert.deepEqual(calls.slice(1).map(c => c.body.text).sort(), ["first", "second"]);
    await sendMessage("third");
    assert.equal(calls.at(-1).body.text, "third", "queue remains usable");
  } finally {
    mock.restoreAll();
  }
});
