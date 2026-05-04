import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { MIGRATIONS } from "../../migrations/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KAIROS_DB_PATH
  ? path.resolve(process.env.KAIROS_DB_PATH)
  : path.join(__dirname, "kairos.db");

let _db = null;
let _initPromise = null;

async function _initDB() {
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  initSchema(_db);
}

export function getDB() {
  if (_db) return _db;
  if (!_initPromise) _initPromise = _initDB();
  return _initPromise.then(() => _db);
}

export function runTransaction(fn) {
  // Try BEGIN; if already in transaction, use SAVEPOINT for nested case
  let isSavepoint = false;
  try {
    _db.exec("BEGIN");
  } catch (e) {
    if (e.message && e.message.includes("within a transaction")) {
      // Nested transaction — use SAVEPOINT
      _db.exec("SAVEPOINT sp_trans");
      isSavepoint = true;
    } else {
      throw e;
    }
  }
  try {
    fn();
    if (isSavepoint) {
      _db.exec("RELEASE sp_trans");
    } else {
      _db.exec("COMMIT");
    }
  } catch (e) {
    if (isSavepoint) {
      _db.exec("ROLLBACK TO sp_trans");
    } else {
      _db.exec("ROLLBACK");
    }
    throw e;
  }
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT
    )
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM _schema_versions").all().map(r => r.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    migration.fn(db);
    db.prepare("INSERT INTO _schema_versions (version, applied_at) VALUES (?, ?)").run(
      migration.id,
      new Date().toISOString()
    );
    log("info", "db", `Applied migration #${migration.id} (${migration.name})`);
  }
}

export function initSchema(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool ON pool_snapshots(pool_address)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)`);
}

export function _injectDB(db) {
  if (_db && _db !== db) _db.close();
  _db = db;
}

export function closeDB() {
  if (_db) {
    _db.close();
    _db = null;
    _initPromise = null;
  }
}

export function tableHasColumn(tableName, columnName) {
  const columns = _db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some(col => col.name === columnName);
}
