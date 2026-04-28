/**
 * Shared time utilities.
 */

/**
 * Returns how many minutes ago a timestamp was.
 * Accepts a Date, ISO string, Unix timestamp (seconds), or ms value.
 * @param {number|string|Date} timestamp
 * @returns {number}
 */
export function minutesAgo(timestamp) {
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000);
}
