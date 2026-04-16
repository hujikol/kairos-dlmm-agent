import fs from "fs";
import path from "path";
import { rotateIfNeeded } from "./rotation.js";

const LOG_DIR = "./logs";

/**
 * Log a portfolio snapshot (for tracking performance over time).
 * Writes to logs/snapshots-YYYY-MM-DD.jsonl.
 */
export function logSnapshot(snapshot) {
  const timestamp = new Date().toISOString();

  const entry = {
    timestamp,
    ...snapshot,
  };

  const dateStr = timestamp.split("T")[0];
  const snapshotFile = path.join(LOG_DIR, `snapshots-${dateStr}.jsonl`);
  rotateIfNeeded(snapshotFile);
  fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
}
