/**
 * Memory watchdog — periodic heap check for 8GB RAM machines.
 * Logs heap usage every 5 min. Warns if >3.5GB.
 * Triggers emergency cleanup (cache clear + gc) if heap exceeds 3GB.
 */

import { log } from "./logger.js";
import { clearCache } from "../tools/cache.js";

let _timer = null;

export function startMemoryWatchdog() {
  if (_timer) return; // idempotent — prevent duplicate intervals
  _timer = setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    log("info", "memory", `Heap: ${heapUsedMB}MB used / ${heapTotalMB}MB total`);

    if (heapUsedMB > 3500) {
      log("warn", "memory", `High heap usage: ${heapUsedMB}MB`);
    }

    // Emergency cleanup when heap exceeds 3GB
    if (heapUsedMB > 3000) {
      log("warn", "memory", `Emergency cleanup triggered — heap at ${heapUsedMB}MB`);
      clearCache();
      if (typeof global.gc === "function") {
        log("info", "memory", "Calling global.gc() after cleanup");
        global.gc();
      }
    }
  }, 300_000);
  _timer.unref();
}

export function stopMemoryWatchdog() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}