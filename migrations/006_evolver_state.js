/**
 * Migration 006: Evolver State Persistence
 *
 * Adds evolver_state table to persist _lastEvolvedAt across restarts.
 * The threshold evolver uses this to enforce a cooldown between evolution runs.
 */

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolver_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}
