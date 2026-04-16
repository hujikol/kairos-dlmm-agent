import { closeDB } from "../core/db.js";
import { stopCronJobs } from "../core/scheduler.js";
import { stopPolling } from "../notifications/telegram.js";
import { stopWatchdog } from "../watchdog.js";
import { getMyPositions } from "../integrations/meteora.js";
import { log } from "../core/logger.js";

let _promptRefreshInterval = null;
let _healthServer = null;

async function shutdown(signal) {
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