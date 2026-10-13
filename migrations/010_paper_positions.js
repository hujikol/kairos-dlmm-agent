export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS paper_positions (
    position TEXT PRIMARY KEY, closed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  )`);
}
