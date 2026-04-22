/**
 * Shared database helpers — extracted from dev-blocklist.js and token-blacklist.js
 * to eliminate duplicated DB-ready guards.
 */

/**
 * Returns true when the database is ready for queries.
 * Checks both that db exists and that it has the prepare() method (sqlite3 api).
 *
 * @param {object} db - getDB() result
 * @returns {boolean}
 */
export function isDbReady(db) {
  return !!(db && typeof db.prepare === "function");
}