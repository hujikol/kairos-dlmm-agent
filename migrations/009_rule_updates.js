export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rule_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    previous TEXT NOT NULL,
    proposed TEXT,
    activated INTEGER NOT NULL,
    validation TEXT NOT NULL
  )`);
}
