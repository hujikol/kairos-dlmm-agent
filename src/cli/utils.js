/**
 * kairos CLI — shared utilities
 * All command modules import from here.
 */
import "dotenv/config";
import os from "os";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";

// ─── DRY_RUN flag ────────────────────────────────────────────────
export const DRY_RUN = process.argv.includes("--dry-run");
if (DRY_RUN) process.env.DRY_RUN = "true";

// ─── Load .env from ~/.kairos/ if present ──────────────────────
const kairosDir = path.join(os.homedir(), ".kairos");
const kairosEnv = path.join(kairosDir, ".env");
if (fs.existsSync(kairosEnv)) {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: kairosEnv, override: false });
}

// ─── Output helpers ───────────────────────────────────────────────
export function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function die(msg, extra = {}) {
  process.stderr.write(JSON.stringify({ error: msg, ...extra }) + "\n");
  process.exit(1);
}

// ─── Command defaults ───────────────────────────────────────────────
export const COMMAND_DEFAULTS = {
  CANDIDATES_LIMIT:    5,
  TOKEN_HOLDERS_LIMIT: 20,
  SEARCH_POOLS_LIMIT:  10,
  STUDY_LIMIT:          4,
  LESSONS_LIMIT:       50,
  PERFORMANCE_LIMIT:  200,
};

// ─── Argv/flags parsing helpers ─────────────────────────────────────
export function parseCliArgs(argv) {
  const subcommand = argv.find(a => !a.startsWith("-"));
  const sub2 = argv.filter(a => !a.startsWith("-"))[1];
  const silent = argv.includes("--silent");

  const { values: flags } = parseArgs({
    args: argv,
    options: {
      pool:       { type: "string" },
      amount:     { type: "string" },
      position:   { type: "string" },
      from:       { type: "string" },
      to:         { type: "string" },
      strategy:   { type: "string" },
      query:      { type: "string" },
      mint:       { type: "string" },
      wallet:     { type: "string" },
      timeframe:  { type: "string" },
      reason:     { type: "string" },
      "bins-below": { type: "string" },
      "bins-above": { type: "string" },
      "amount-x":   { type: "string" },
      "amount-y":   { type: "string" },
      "bps":        { type: "string" },
      "no-claim":   { type: "boolean" },
      "skip-swap":  { type: "boolean" },
      "dry-run":    { type: "boolean" },
      "silent":     { type: "boolean" },
      limit:        { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  return { subcommand, sub2, silent, flags };
}
