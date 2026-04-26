/**
 * Migration 005: Add bin fields to pool_deploys.
 *
 * Adds lower_bin, upper_bin, total_bins to support bin-learning
 * suggestions based on historical performance.
 *
 * down(): no-op — bin data is harmless to keep, dropping achieves nothing.
 */

export function up(db) {
  // ALTER TABLE is safe to re-run — SQLite ignores ADD COLUMN if column already exists
  db.prepare(`ALTER TABLE pool_deploys ADD COLUMN lower_bin INTEGER`).run();
  db.prepare(`ALTER TABLE pool_deploys ADD COLUMN upper_bin INTEGER`).run();
  db.prepare(`ALTER TABLE pool_deploys ADD COLUMN total_bins INTEGER`).run();
}

export function down(db) {
  // no-op — see docstring
}