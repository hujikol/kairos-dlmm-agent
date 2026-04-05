/**
 * Notification queue — collects deploy/close/swap/OOR events
 * so they can be flushed as a single consolidated Telegram message.
 */

let _queue = [];

/**
 * Push a notification onto the queue.
 * Types: "deploy", "close", "swap", "oor", "claim"
 */
export function pushNotification(note) {
  _queue.push(note);
}

/**
 * Return and clear the queue. Returns a copy.
 */
export function flushNotifications() {
  const copy = [..._queue];
  _queue = [];
  return copy;
}

/**
 * Check if queue has items (for deciding whether to send).
 */
export function hasPendingNotifications() {
  return _queue.length > 0;
}
