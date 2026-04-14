/**
 * Migration Runner — manages database schema migrations with rollback support.
 *
 * Usage:
 *   node migrations/runner.js          — run all pending migrations (up)
 *   node migrations/runner.js down    — roll back the last migration
 *   node migrations/runner.js status  — show current migration version
 *
 * Each migration file must export:
 *   up(db)   — apply the migration
 *   down(db) — rollback the migration
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDB } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = __dirname;

// Track current schema version in the database
const SCHEMA_VERSION_KEY = "schema_version";

function getVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(SCHEMA_VERSION_KEY);
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    // kv_store might not exist yet
    return 0;
  }
}

function setVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run(SCHEMA_VERSION_KEY, String(version));
}

/**
 * Load all migration files, sorted by version number.
 */
async function loadMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".js") && f !== "runner.js")
    .sort();
  const migrations = [];
  for (const f of files) {
    const mod = await import(path.join(MIGRATIONS_DIR, f));
    const base = f.replace(/\.js$/, "");
    const parts = base.split("-");
    const version = parseInt(parts[0], 10);
    migrations.push({ version, name: base, up: mod.up, down: mod.down });
  }
  return migrations;
}

/**
 * Get list of pending migrations (versions greater than current).
 */
function getPendingMigrations(db, migrations) {
  const current = getVersion(db);
  return migrations.filter(m => m.version > current);
}

/**
 * Run all pending migrations.
 */
export async function migrateUp() {
  const db = getDB();
  const migrations = await loadMigrations();
  const pending = getPendingMigrations(db, migrations);

  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const m of pending) {
    console.log(`Applying migration ${m.version}: ${m.name}...`);
    try {
      await m.up(db);
      setVersion(db, m.version);
      console.log(`Migration ${m.version} applied.`);
    } catch (err) {
      console.error(`Migration ${m.version} failed: ${err.message}`);
      throw err;
    }
  }
  console.log(`Applied ${pending.length} migration(s).`);
}

/**
 * Roll back the last applied migration.
 */
export async function migrateDown() {
  const db = getDB();
  const migrations = await loadMigrations();
  const current = getVersion(db);

  if (current === 0) {
    console.log("Already at version 0 — nothing to roll back.");
    return;
  }

  // Find the migration with the current version
  const target = migrations.find(m => m.version === current);
  if (!target) {
    console.error(`No migration found for version ${current}.`);
    throw new Error(`Missing migration for version ${current}`);
  }

  if (!target.down) {
    console.error(`Migration ${current} does not support rollback.`);
    throw new Error(`Migration ${current} has no down() function.`);
  }

  console.log(`Rolling back migration ${current}: ${target.name}...`);
  try {
    await target.down(db);
    const prevVersion = current - 1;
    setVersion(db, prevVersion);
    console.log(`Rolled back to version ${prevVersion}.`);
  } catch (err) {
    console.error(`Rollback of migration ${current} failed: ${err.message}`);
    throw err;
  }
}

/**
 * Show current migration version.
 */
export async function migrateStatus() {
  const db = getDB();
  const migrations = await loadMigrations();
  const version = getVersion(db);
  console.log(`Current version: ${version}`);
  console.log(`Total migrations: ${migrations.length}`);
  if (version < migrations.length) {
    const next = migrations.find(m => m.version === version + 1);
    if (next) console.log(`Next pending: ${next.version} — ${next.name}`);
  }
}

// CLI entry point
const cmd = process.argv[2];
if (cmd === "down") {
  migrateDown().catch(err => { console.error(err.message); process.exit(1); });
} else if (cmd === "status") {
  migrateStatus().catch(err => { console.error(err.message); process.exit(1); });
} else {
  migrateUp().catch(err => { console.error(err.message); process.exit(1); });
}
