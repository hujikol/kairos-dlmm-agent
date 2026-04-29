import { closeDB } from "../core/db.js";
import { stopCronJobs } from "../core/scheduler.js";
import { stopPolling } from "../notifications/telegram.js";
import { stopWatchdog } from "../watchdog.js";
import { getMyPositions } from "../integrations/meteora.js";
import { log } from "../core/logger.js";

let _promptRefreshInterval = null;
let _healthServer = null;
let _shutdownPromise = null;

async function shutdown(signal) {
  if (_shutdownPromise) return _shutdownPromise;

  _shutdownPromise = (async () => {
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
  })().catch((e) => {
    log("error", "shutdown", `Shutdown failed: ${e?.message ?? String(e)}`);
    process.exit(1);
  });

  return _shutdownPromise;
}

process.on("SIGINT", () => { shutdown("SIGINT").catch(() => {}); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => {}); });

export function setHealthServer(server) {
  _healthServer = server;
}

export function setPromptRefreshInterval(interval) {
  _promptRefreshInterval = interval;
}

export { shutdown };
