import http from "http";
import { log } from "../core/logger.js";
import { timers } from "../core/scheduler.js";
import { getMyPositions } from "../integrations/meteora.js";

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3030", 10);

export function createHealthServer() {
  return http.createServer(async (req, res) => {
    if (req.url === "/health") {
      const { positions } = await getMyPositions({ force: false, silent: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        lastCycle: timers.managementLastRun || null,
        positionCount: positions.length,
      }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

export function startHealthServer(server) {
  server.listen(HEALTH_PORT, () => {
    log("info", "startup", `Health endpoint listening on port ${HEALTH_PORT}`);
  });
}