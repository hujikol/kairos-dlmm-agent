import test from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyTelegramCommand } from "../src/telegram-queue.js";

test("read-only Telegram commands bypass a busy cycle", () => {
  for (const command of ["/balance", "/status", "/positions", "/thresholds", "/candidates"]) {
    assert.equal(isReadOnlyTelegramCommand(command), true, command);
  }
});

test("mutating Telegram commands remain queued during a busy cycle", () => {
  for (const command of ["/screen", "/swap-all", "/briefing", "close position"]) {
    assert.equal(isReadOnlyTelegramCommand(command), false, command);
  }
});
