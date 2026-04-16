/**
 * Event log — pushEvent / getRecentEvents.
 * All functions share the same getDB() from ../db.js.
 */

import { getDB } from "../db.js";

const MAX_RECENT_EVENTS = 20;

/**
 * Append to the recent events log (shown in every prompt).
 */
export function pushEvent(event) {
  const db = getDB();
  db.transaction(() => {
    db.prepare("INSERT INTO recent_events (ts, action, position, pool_name, reason) VALUES (?, ?, ?, ?, ?)").run(
      new Date().toISOString(), event.action, event.position, event.pool_name, event.reason || null,
    );
    db.prepare(`
      DELETE FROM recent_events WHERE id NOT IN (
        SELECT id FROM (SELECT id FROM recent_events ORDER BY id DESC LIMIT ?)
      )
    `).run(MAX_RECENT_EVENTS);
  })();
}

/**
 * Get the most recent events.
 * @param {number} [limit=10]
 * @returns {Array<Object>}
 */
export function getRecentEvents(limit = 10) {
  const db = getDB();
  return db.prepare("SELECT * FROM recent_events ORDER BY id DESC LIMIT ?").all(limit).reverse();
}
