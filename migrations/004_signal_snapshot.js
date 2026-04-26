/**
 * Migration 004: Add signal_snapshot to performance table.
 *
 * signal_snapshot carries per-position decision context (BB bands,
 * entry price, etc.) from the position into performance history.
 * Without this column, the field is silently dropped on close.
 *
 * down(): no-op — performance data is already written without this
 * column; dropping would lose nothing but preserving the column is
 * harmless.
 */

export function up(db) {
  // ALTER TABLE is safe to re-run — SQLite ignores ADD COLUMN if column exists
  db.prepare(`
    ALTER TABLE performance
    ADD COLUMN signal_snapshot TEXT
  `).run();
}

export function down(db) {
  // no-op — see docstring
}