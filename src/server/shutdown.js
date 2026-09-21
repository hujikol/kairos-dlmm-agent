import { stopMemoryWatchdog } from "../core/memory-watchdog.js";
import { diagnostic } from "../core/diagnostics.js";
import { closeDB } from "../core/db.js";
import { stopCronJobs } from "../core/scheduler.js";
import { stopPolling } from "../notifications/telegram.js";
import { stopWatchdog } from "../watchdog.js";
import { getMyPositions } from "../integrations/meteora.js";
import { log } from "../core/logger.js";

let _promptRefreshInterval = null;
let _healthServer = null;
let _shuttingDown = false;

async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  diagnostic("shutdown_started");
  // Note: inflight RPC promises should be awaited before exit. Current implementation
  // races them against a 10s timeout via Promise.all — revisit for graceful completion.
  log("info", "shutdown", `Received ${signal}. Shutting down...`);
  clearInterval(_promptRefreshInterval);
  stopCronJobs();
  stopWatchdog();
  if (_healthServer) _healthServer.close();

  await Promise.race([
    Promise.all([
      stopPolling(),
      getMyPositions().catch(() => []),
    ]),
    new Promise(r => setTimeout(r, 10_000)),
  ]);

  await closeDB();
  diagnostic("shutdown_completed");
  stopMemoryWatchdog();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export function setHealthServer(server) {
  _healthServer = server;
}

export function setPromptRefreshInterval(interval) {
  _promptRefreshInterval = interval;
}

export { shutdown };