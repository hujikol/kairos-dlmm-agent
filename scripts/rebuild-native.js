/**
 * Rebuilds native modules for the current Node version.
 *
 * sql.js is pure WASM — no native compilation needed.
 * Kept as a no-op for compatibility with existing tooling.
 */

import { execSync } from "child_process";
import console from "console";

try {
  // sql.js has no native deps — nothing to rebuild
  console.log("sql.js: no native rebuild needed");
} catch (e) {
  console.error("rebuild-native:", e.message);
  process.exit(1);
}