/**
 * Migration Template — use this as a starting point for new migrations.
 *
 * Each migration MUST export:
 *   up(db)   — apply the migration (add columns, tables, indexes, etc.)
 *   down(db) — rollback the migration (restore previous state)
 *
 * Naming convention: XXX-description.js where XXX is a 3-digit version number.
 * Keep version numbers sequential — do not reuse or skip numbers.
 *
 * Example usage:
 *   // In up():
 *   db.exec(`ALTER TABLE positions ADD COLUMN new_field TEXT`);
 *
 *   // In down():
 *   // SQLite doesn't support DROP COLUMN directly, so use table recreation:
 *   // 1. Create new table without the column
 *   // 2. Copy data
 *   // 3. Drop old table
 *   // 4. Rename new table
 */

/**
 * @param {import('better-sqlite3').Database} db
 */
export async function up(db) {
  // Example: Add a new index
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_positions_new_field ON positions(new_field);
  `);

  // Or: Add a new column
  // db.exec(`ALTER TABLE positions ADD COLUMN new_field TEXT`);

  console.log("Migration up complete");
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export async function down(db) {
  // Rollback must reverse the up() changes exactly.
  //
  // SQLite doesn't support DROP COLUMN, so for column drops
  // or table structure changes, use table recreation:
  //
  // db.exec(`
  //   CREATE TABLE IF NOT EXISTS positions_backup AS SELECT * FROM positions;
  //   DROP TABLE positions;
  //   CREATE TABLE positions (...columns WITHOUT new_field...);
  //   INSERT INTO positions SELECT ...columns from backup...;
  //   DROP TABLE positions_backup;
  // `);

  // Example: Drop the index created in up()
  db.exec(`DROP INDEX IF EXISTS idx_positions_new_field`);

  console.log("Migration down complete");
}
