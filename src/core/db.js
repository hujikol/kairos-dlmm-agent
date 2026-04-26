import initSqlJs from "sql.js";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { MIGRATIONS } from "../../migrations/index.js";
import { createAllTables } from "../../migrations/001_initial_schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KAIROS_DB_PATH
  ? path.resolve(process.env.KAIROS_DB_PATH)
  : path.join(__dirname, "kairos.db");

// sql.js runs in-memory — persist to disk on close
let _db = null;
let _initPromise = null;
let _transactionDepth = 0;
let _isSqlJs = true; // true = sql.js, false = better-sqlite3

async function _initDB() {
  const SQL = await initSqlJs();

  let data;
  if (fsSync.existsSync(DB_PATH)) {
    data = fsSync.readFileSync(DB_PATH);
  }

  _db = new SQL.Database(data);
  _isSqlJs = true;
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA foreign_keys = ON");

  _extendDb();
  migrate(_db);
  initSchema(_db);
}

/**
 * Get the database instance.
 *
 * After initialization: returns _db synchronously (safe for all callers).
 * During initialization: starts init if not started, caller MUST await.
 * Before initialization completes: returns undefined — caller MUST await.
 */
export function getDB() {
  if (_db) return _db;
  if (!_initPromise) _initPromise = _initDB();
  // Return unresolved promise — caller must await this specific call
  return _initPromise.then(() => _db);
}

// ─── sql.js-compatible wrappers (operate on the cached _db) ──────────────────

// Raw prepare function captured before db.prepare is overridden
let _rawPrepare = null;
// Raw Database.run method captured before _db.run is overridden
let _rawRun = null;

function _setRawPrepare() {
  if (_isSqlJs) {
    _rawPrepare = _db.prepare.bind(_db);
    _rawRun = _db.run.bind(_db);
  }
}

/** Run a query and return all rows */
function _all(sql, ...bindParams) {
  if (_isSqlJs) {
    const stmt = _rawPrepare(sql);
    if (bindParams.length > 0) stmt.bind(bindParams);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } else {
    return _db.prepare(sql).all(...bindParams);
  }
}

/** Run a query and return the first row */
function _get(sql, ...bindParams) {
  if (_isSqlJs) {
    const stmt = _rawPrepare(sql);
    if (bindParams.length > 0) stmt.bind(bindParams);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  } else {
    return _db.prepare(sql).get(...bindParams);
  }
}

/** Run a statement (INSERT/UPDATE/DELETE) and return changes info */
function _run(sql, ...bindParams) {
  if (_isSqlJs) {
    _rawRun(sql, bindParams);
    return { changes: _db.getRowsModified(), lastInsertRowid: 0 };
  } else {
    _db.prepare(sql).run(...bindParams);
    return { changes: 1, lastInsertRowid: 0 };
  }
}

/**
 * Execute a function inside a BEGIN/COMMIT transaction.
 * sql.js does not implement db.transaction(), so we use manual SQL.
 * better-sqlite3 uses db.transaction() directly.
 * Re-entrant: nested calls increment depth counter, only outermost
 * call actually BEGINs/COMMITs. Avoids "cannot start a transaction
 * within a transaction" on sql.js.
 */
export function runTransaction(fn) {
  if (_isSqlJs) {
    if (_transactionDepth === 0) _db.exec("BEGIN");
    _transactionDepth++;
    try {
      fn();
      if (_transactionDepth === 1) _db.exec("COMMIT");
    } catch (e) {
      if (_transactionDepth === 1) _db.exec("ROLLBACK");
      throw e;
    } finally {
      _transactionDepth--;
    }
  } else {
    _db.transaction(fn)();
  }
}

/** Prepare a statement — returns an object with .all(), .get(), .run() (sql.js only) */
function _makePreparedStatement(sql) {
  const stmt = _rawPrepare(sql);
  return {
    all: (...bindParams) => {
      if (bindParams.length > 0) stmt.bind(bindParams);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    get: (...bindParams) => {
      if (bindParams.length > 0) stmt.bind(bindParams);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row;
    },
    run: (...bindParams) => {
      if (bindParams.length > 0) stmt.bind(bindParams);
      stmt.step();
      stmt.free();
      return { changes: _isSqlJs ? _db.getRowsModified() : 1, lastInsertRowid: 0 };
    },
    _stmt: stmt,
  };
}

// Attach helpers to _db so callers can use db.all() / db.get() / db.prepare()
function _extendDb() {
  if (!_db) return;
  _setRawPrepare();
  _db.all = _all;
  _db.get = _get;
  // Only override prepare() for sql.js (which returns raw stmt objects).
  // better-sqlite3's db.prepare() already returns stmts with .all/.get/.run.
  if (_isSqlJs) {
    _db.prepare = _makePreparedStatement;
  }
}

// ─── Test injection ───────────────────────────────────────────────────────────

/** Inject a test database instance (for unit tests only). */
export function _injectDB(db) {
  if (!db) return;
  if (_db && _db !== db) {
    try { _db.close(); } catch { log("warn", "db", "failed to close db"); }
  }
  _db = db;
  // Detect engine: sql.js Database has ._db property, better-sqlite3 does not
  _isSqlJs = !!db._db;
  if (_isSqlJs) {
    _rawRun = db._db.run.bind(db._db);
    _rawPrepare = db._db.prepare.bind(db._db);
  } else {
    // better-sqlite3: use db.exec for raw statements, prepare().run/get/all natively
    _rawRun = null; // not used — better-sqlite3 uses db.exec
    _rawPrepare = null; // not used — native prepare handles this
  }
  _extendDb();
  // Run migrations and schema init on the injected test DB
  migrate(db);
  initSchema(db);
}

// ─── Schema Migration Runner ──────────────────────────────────────────────────

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT
    )
  `);

  const applied = new Set(
    _all("SELECT version FROM _schema_versions").map(r => r.version)
  );

  // Ensure all core tables exist — catches DBs that pre-date the migration
  // system or have partial schemas. CREATE TABLE IF NOT EXISTS is idempotent.
  createAllTables(db);

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    migration.fn(db);
    _run(
      "INSERT INTO _schema_versions (version, applied_at) VALUES (?, ?)",
      migration.id,
      new Date().toISOString()
    );
    log("info", "db", `Applied migration #${migration.id} (${migration.name})`);
  }

  // Initialize feature flags to "false" on first run if not already present
  const FLAG_PREFIX = "flag_";
  const PLANNED_FLAGS = [
    "gmgn_holders_enabled",
    "gmgn_price_enabled",
    "bb_strategy_enabled",
    "dynamic_sizing_enabled",
    "auto_shift_bins_enabled",
    "auto_claim_sol_enabled",
    "token_security_enabled",
  ];
  for (const flag of PLANNED_FLAGS) {
    const key = FLAG_PREFIX + flag;
    const existing = db.prepare(`SELECT key FROM kv_store WHERE key = ?`).get(key);
    if (!existing) {
      db.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`).run(key, "false");
    }
  }
}

// ─── Utility: Check if a column exists in a table ─────────────────────────────

export function tableHasColumn(db, table, column) {
  const info = _db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some(col => col.name === column);
}

// ─── initSchema: index creation safety net ───────────────────────────────────
// SCHEMA SOURCE OF TRUTH: migrations/index.js (migrations 001, 002, ...)
//
// All table creation is handled by migrate() which runs before initSchema().
// initSchema() remains solely as a safety net for indexes, ensuring they are
// created even on databases created before a migration added a new index.
//
// DO NOT add new CREATE TABLE statements here — add them to migrations/ instead.
export function initSchema(db) {
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address)`,
    `CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool ON pool_snapshots(pool_address)`,
    `CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed)`,
    `CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at)`,
    `CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at)`,
    `CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role)`,
    `CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome)`,
  ];
  for (const sql of indexes) {
    try { db.exec(sql); } catch { log("warn", "db", "failed to create index"); }
  }
}

/**
 * Shut down the db cleanly — writes the in-memory database to disk.
 */
export async function closeDB() {
  if (_db) {
    if (_isSqlJs) {
      fsSync.writeFileSync(DB_PATH, _db.export());
    }
    _db.close();
    _db = null;
    _initPromise = null;
  }
}

/**
 * Validate an ISO 8601 timestamp string.
 */
export function isValidISO(str) {
  if (typeof str !== "string") return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}