import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
const LOG_MAX_SIZE_BYTES = parseInt(process.env.LOG_MAX_SIZE || "10000000", 10); // 10 MB
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES || "7", 10);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Open a log stream for appending (idempotent per process lifetime).
 * Returns the file path for the current day's log.
 */
export function openLogStream(baseName) {
  const dateStr = new Date().toISOString().split("T")[0];
  return path.join(LOG_DIR, `${baseName}-${dateStr}.log`);
}

/**
 * Rotate a log file if it exceeds the size threshold.
 * Rename current file to .1, .2, ... up to LOG_MAX_FILES, then truncate current.
 */
export function rotateIfNeeded(logFile) {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size < LOG_MAX_SIZE_BYTES) return;

    // Prune oldest
    const base = logFile.replace(/\.\d+$/, "");
    const oldest = base + "." + LOG_MAX_FILES;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    // Shift existing rotations
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
      const src = base + "." + i;
      const dst = base + "." + (i + 1);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }

    // Rotate current to .1
    fs.renameSync(logFile, base + ".1");
    // Truncate current file
    fs.writeFileSync(logFile, "");
  } catch (err) {
    // Cannot log here without infinite recursion — surface via console
    console.error(`[logger] Log rotation failed: ${err.message}`);
  }
}
