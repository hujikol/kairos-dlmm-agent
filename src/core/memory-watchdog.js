/**
 * Memory watchdog — periodic heap check for 8GB RAM machines.
 * Logs heap usage every 5 min. Warns if >3.5GB.
 */

import { log } from "./logger.js";

let _timer = null;

export function startMemoryWatchdog() {
  _timer = setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    log("info", "memory", `Heap: ${heapUsedMB}MB used / ${heapTotalMB}MB total`);

    if (heapUsedMB > 3500) {
      log("warn", "memory", `High heap usage: ${heapUsedMB}MB`);
      // Log cache sizes if available
      import("../tools/cache.js").then(m => {
        log("info", "memory", `tools/cache CACHE size: ${m.CACHE.size}`);
      }).catch(() => {});
    }
  }, 300_000);
}

export function stopMemoryWatchdog() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
