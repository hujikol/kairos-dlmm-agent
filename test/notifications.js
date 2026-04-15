/**
 * Notification queue tests.
 *
 * Behavioral tests:
 * 1. pushNotification adds to queue
 * 2. flushNotifications returns and clears queue
 * 3. hasPendingNotifications reflects queue state
 * 4. Queue is empty after flush
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as queue from "../src/notifications/queue.js";

describe("notifications/queue", () => {
  beforeEach(() => {
    // Always start with a clean queue
    queue.flushNotifications();
  });

  it("pushNotification adds a notification to the queue", () => {
    assert.equal(queue.hasPendingNotifications(), false);
    queue.pushNotification({ type: "deploy", message: "test" });
    assert.equal(queue.hasPendingNotifications(), true);
  });

  it("pushNotification accumulates multiple notifications", () => {
    queue.pushNotification({ type: "deploy", msg: "a" });
    queue.pushNotification({ type: "close", msg: "b" });
    queue.pushNotification({ type: "oor", msg: "c" });
    const flushed = queue.flushNotifications();
    assert.equal(flushed.length, 3);
    assert.equal(flushed[0].type, "deploy");
    assert.equal(flushed[1].type, "close");
    assert.equal(flushed[2].type, "oor");
  });

  it("flushNotifications returns and clears the queue", () => {
    queue.pushNotification({ type: "swap", msg: "x" });
    const flushed = queue.flushNotifications();
    assert.equal(flushed.length, 1);
    assert.equal(queue.hasPendingNotifications(), false);
    assert.equal(queue.flushNotifications().length, 0); // second flush is empty
  });

  it("flushNotifications returns a copy (original is cleared)", () => {
    queue.pushNotification({ type: "claim", msg: "y" });
    const flushed = queue.flushNotifications();
    flushed.push({ type: "extra" }); // mutate copy
    assert.equal(queue.hasPendingNotifications(), false); // original unchanged
  });
});
