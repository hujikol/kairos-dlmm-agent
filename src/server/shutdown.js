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
  stopPolling();
  stopWatchdog();
  if (_healthServer) _healthServer.close();
  const positions = await getMyPositions();
  log("info", "shutdown", `Open positions at shutdown: ${positions.total_positions}`);
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