/**
 * Rebuilds native modules for the current Node version.
 *
 * better-sqlite3 is a native addon that must be rebuilt when Node version changes.
 * Run this after upgrading Node, or after npm install --ignore-scripts.
 */

import { execSync } from "child_process";
import console from "console";

try {
  execSync("npm rebuild better-sqlite3", { stdio: "inherit" });
  console.log("Rebuilt: better-sqlite3");
} catch (e) {
  console.error("Failed to rebuild better-sqlite3:", e.message);
  process.exit(1);
}