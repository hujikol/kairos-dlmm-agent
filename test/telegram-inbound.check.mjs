import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("Telegram read-only flood stays bounded and drains once after busy cycles", { timeout: 5000 }, async () => {
  const stub = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });
  stub("../src/core/logger.js", { log() {} });
  const busy = { _managementBusy: false, _screeningBusy: false };
  stub("../src/core/state/scheduler-state.js", { _busyState: busy });
  stub("../src/notifications/telegram.js", { startPolling() {}, stopPolling() {},
    sendHTML: async () => {}, sendMessage: async () => {}, sendMessageDirect: async () => {},
    sendChatAction: async () => {}, sendRichMessage: async () => {} });
  stub("../src/agent/index.js", { agentLoop: async () => { throw new Error("Unexpected AI call"); } });
  stub("../src/core/cycle-helpers.js", { escapeHTMLLocal: s => s });
  let active = 0, peak = 0, processed = 0;
  const releases = [];
  const handler = async () => {
    active++; peak = Math.max(peak, active); processed++;
    await new Promise(r => releases.push(r));
    active--;
  };
  const names = ["handleBriefing", "handleBalance", "handleStatus", "handleCandidates", "handleScreen", "handleSwapAll", "handleThresholds", "handlePositions", "handleClose", "handleSet", "handleTeach", "handleCaveman", "handleLearn", "handleSafeModeCommand"];
  stub("../src/telegram/commands/index.js", Object.fromEntries(names.map(n => [n, handler])));
  const { telegramHandler, drainTelegramQueue, _telegramBusy } = await import("../src/telegram/index.js");
  const tick = () => new Promise(r => setImmediate(r));
  const first = Array.from({ length: 3 }, () => telegramHandler("/balance"));
  await tick();
  assert.equal(active, 3);
  await Promise.all(Array.from({ length: 15 }, () => telegramHandler("/balance")));
  assert.equal(active, 3, "read-only commands respect concurrency cap");
  for (let i = 0; i < 10; i++) {
    releases.splice(0).forEach(r => r());
    await tick();
  }
  await Promise.all(first);
  assert.equal(processed, 13, "only 10 queued commands accepted beyond active three");
  assert.equal(peak, 3);
  assert.equal(_telegramBusy._count, 0);
  busy._managementBusy = true;
  await telegramHandler("/screen");
  drainTelegramQueue();
  await tick();
  assert.equal(processed, 13);
  busy._managementBusy = false;
  drainTelegramQueue();
  await tick();
  releases.splice(0).forEach(r => r());
  await tick();
  assert.equal(processed, 14);
  assert.equal(_telegramBusy._count, 0);
  const heapStart = process.memoryUsage().heapUsed;
  for (let batch = 0; batch < 500; batch++) {
    const tasks = Array.from({ length: 3 }, () => telegramHandler("/balance"));
    await tick();
    releases.splice(0).forEach(r => r());
    await Promise.all(tasks);
  }
  assert.equal(_telegramBusy._count, 0);
  assert.equal(peak, 3);
  if (global.gc) {
    global.gc();
    assert.ok(process.memoryUsage().heapUsed - heapStart < 8 * 1024 * 1024, "drained command flood retains less than 8 MB");
  }
  let scheduled = 0;
  const original = globalThis.setImmediate;
  mock.method(globalThis, "setImmediate", (...args) => { scheduled++; return original(...args); });
  for (let i = 0; i < 100; i++) drainTelegramQueue();
  assert.equal(scheduled, 0, "empty drain never schedules recursive work");
  mock.restoreAll();
});
