/**
 * DB Backup — copies kairos.db to backups/kairos-{date}.db
 * Keeps last 7 backups, pruning older ones.
 *
 * Usage:
 *   node scripts/backup-db.js              — run manually
 *   node scripts/backup-db.js --dry-run   — show what would happen
 *   node scripts/backup-db.js --verify    — verify most recent backup with PRAGMA integrity_check
 *
 * Environment:
 *   BACKUP_DEST_DIR   — if set, copy backup there as well (offsite mount)
 *   KAIROS_DB_PATH    — path to source DB (default: src/core/kairos.db)
 *
 * Cron example (daily at 03:00):
 *   0 3 * * * cd /path/to/kairos && node scripts/backup-db.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = process.env.KAIROS_DB_PATH
  ? path.resolve(process.env.KAIROS_DB_PATH)
  : path.join(__dirname, "../src/core/kairos.db");
const BACKUP_DIR = path.join(__dirname, "../backups");
const MAX_BACKUPS = 7;

const DRY_RUN   = process.argv.includes("--dry-run");
const VERIFY    = process.argv.includes("--verify");
const OFFSITE_DIR = process.env.BACKUP_DEST_DIR || null;

// Telegram alert helper (lazy import to avoid circular deps)
async function sendAlert(msg) {
  try {
    const { sendMessage, isEnabled } = await import("../src/notifications/telegram.js");
    if (!isEnabled()) return;
    await sendMessage(`[BACKUP FAILURE] ${msg}`);
  } catch (_) {
    // Telegram not available — log only
    console.error(`[ALERT] ${msg}`);
  }
}

/**
 * Run PRAGMA integrity_check on a backup file.
 * @param {string} backupPath
 * @returns {boolean} true if check passes
 */
function integrityCheck(backupPath) {
  try {
    const db = sqlite3(backupPath);
    const result = db.prepare("PRAGMA integrity_check").get();
    db.close();
    const ok = result && result.integrity_check === "ok";
    if (ok) {
      console.log(`Integrity check OK: ${backupPath}`);
    } else {
      console.error(`Integrity check FAILED: ${backupPath} — ${JSON.stringify(result)}`);
    }
    return ok;
  } catch (err) {
    console.error(`Integrity check ERROR: ${backupPath} — ${err.message}`);
    return false;
  }
}

/**
 * Verify that a backup file is a valid SQLite database (basic check).
 * @param {string} backupPath
 * @returns {boolean} true if verification succeeded
 */
function verify(backupPath) {
  try {
    const db = sqlite3(backupPath);
    const result = db.prepare("SELECT count(*) as count FROM sqlite_master").get();
    db.close();
    if (result && typeof result.count === "number") {
      console.log(`Verification OK: ${backupPath} (${result.count} tables)`);
      return true;
    }
    console.error(`Verification FAILED: ${backupPath} — unexpected result`);
    return false;
  } catch (err) {
    console.error(`Verification FAILED: ${backupPath} — ${err.message}`);
    return false;
  }
}

/**
 * Find the most recent backup file in BACKUP_DIR.
 * @returns {string|null}
 */
function findMostRecentBackup() {
  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("kairos-") && f.endsWith(".db"))
    .map(f => ({ file: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.length > 0 ? entries[0].path : null;
}

/**
 * Run the backup.
 * @returns {Promise<{ backedUp: boolean, snapshotFile: string|null, pruned: string[] }>}
 */
export async function runBackup() {
  // Ensure backups dir
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Source must exist
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found at ${DB_PATH}`);
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const snapshotFile = path.join(BACKUP_DIR, `kairos-${dateStr}.db`);

  const pruned = [];

  if (DRY_RUN) {
    console.log(`[dry-run] Would copy ${DB_PATH} -> ${snapshotFile}`);
  } else {
    // Copy current DB snapshot
    fs.copyFileSync(DB_PATH, snapshotFile);
    console.log(`Backed up: ${snapshotFile}`);

    // Verify backup is a valid SQLite database
    if (!verify(snapshotFile)) {
      throw new Error(`Backup verification failed for ${snapshotFile}`);
    }

    // Copy to offsite destination if BACKUP_DEST_DIR is set
    if (OFFSITE_DIR) {
      try {
        if (!fs.existsSync(OFFSITE_DIR)) {
          fs.mkdirSync(OFFSITE_DIR, { recursive: true });
        }
        const offsitePath = path.join(OFFSITE_DIR, path.basename(snapshotFile));
        fs.copyFileSync(snapshotFile, offsitePath);
        console.log(`Offsite backup: ${offsitePath}`);
      } catch (err) {
        console.error(`Offsite backup FAILED (non-fatal): ${err.message}`);
      }
    }
  }

  // Prune backups older than MAX_BACKUPS
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("kairos-") && f.endsWith(".db"))
    .map(f => ({ file: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // newest first

  if (backups.length > MAX_BACKUPS) {
    const toPrune = backups.slice(MAX_BACKUPS);
    for (const b of toPrune) {
      if (DRY_RUN) {
        console.log(`[dry-run] Would prune: ${b.file}`);
      } else {
        fs.unlinkSync(b.path);
        pruned.push(b.file);
        console.log(`Pruned: ${b.file}`);
      }
    }
  } else {
    console.log(`Backup count: ${backups.length}/${MAX_BACKUPS} — no prune needed`);
  }

  return { backedUp: !DRY_RUN, snapshotFile: DRY_RUN ? snapshotFile : null, pruned };
}

// Run directly
const isMain = process.argv[1]?.endsWith("backup-db.js");
if (isMain) {
  runBackup()
    .then(({ backedUp, snapshotFile, pruned }) => {
      if (backedUp) {
        console.log(`\nBackup complete. Snapshot: ${snapshotFile}`);
        if (pruned.length) console.log(`Pruned ${pruned.length} old backup(s).`);
        process.exit(0);
      }
    })
    .catch(err => {
      console.error("Backup failed:", err.message);
      process.exit(1);
    });
}

/**
 * Verify most recent local backup with PRAGMA integrity_check.
 * Sends Telegram alert on failure if Telegram is configured.
 * Exits with code 1 on failure, 0 on success.
 */
async function runVerify() {
  const latest = findMostRecentBackup();
  if (!latest) {
    const msg = "No backup found to verify.";
    console.error(msg);
    await sendAlert(msg);
    process.exit(1);
  }

  if (!integrityCheck(latest)) {
    const msg = `Integrity check FAILED for ${latest}`;
    console.error(msg);
    await sendAlert(msg);
    process.exit(1);
  }

  console.log(`Verification successful: ${latest}`);
  process.exit(0);
}

// Handle --verify mode
if (isMain && VERIFY) {
  runVerify().catch(err => {
    console.error("Verify failed:", err.message);
    process.exit(1);
  });
}