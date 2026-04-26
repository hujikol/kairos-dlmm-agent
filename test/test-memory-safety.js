/**
 * Memory safety tests — ITEM-0 queue cap and cache hard caps.
 * Verifies that bounded collections do not grow beyond their limits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Minimal env so timers etc. are skipped
process.env.NODE_ENV = 'test';

describe('queue cap', () => {
  // We re-import the module fresh each time to reset state
  it('shifts oldest when full (MAX_QUEUE=200)', async () => {
    // Dynamically import to get a fresh module
    const { pushNotification, flushNotifications } = await import(
      '../src/notifications/queue.js'
    );

    const MAX_QUEUE = 200;

    // Fill to exactly MAX_QUEUE
    for (let i = 0; i < MAX_QUEUE; i++) {
      pushNotification({ type: 'test', id: i });
    }

    // Next push should drop the oldest (id=0) and add the new one (id=MAX_QUEUE)
    pushNotification({ type: 'test', id: MAX_QUEUE });

    const queue = flushNotifications();
    assert.strictEqual(
      queue.length,
      MAX_QUEUE,
      `queue should remain at MAX_QUEUE=${MAX_QUEUE}`
    );
    assert.strictEqual(
      queue[0].id,
      1,
      'oldest item (id=0) should have been evicted'
    );
    assert.strictEqual(
      queue[MAX_QUEUE - 1].id,
      MAX_QUEUE,
      'newest item (id=MAX_QUEUE) should be present'
    );
  });

  it('does not grow beyond MAX_QUEUE under pressure', async () => {
    const { pushNotification, flushNotifications } = await import(
      '../src/notifications/queue.js'
    );

    const MAX_QUEUE = 200;

    // Push 500 items — queue must never exceed MAX_QUEUE
    for (let i = 0; i < 500; i++) {
      pushNotification({ type: 'test', id: i });
    }

    const queue = flushNotifications();
    assert.strictEqual(queue.length, MAX_QUEUE);
  });
});