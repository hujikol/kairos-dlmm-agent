import http from "http";
import { log } from "../core/logger.js";
import { timers } from "../core/state/scheduler-state.js";

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3030", 10);

async function checkExternalConnectivity() {
  // Lightweight check: verify RPC_URL is reachable via a tiny RPC call
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

export function createHealthServer() {
  return http.createServer(async (req, res) => {
    if (req.url === "/health") {
      const connected = await checkExternalConnectivity();
      const statusCode = connected ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: connected,
        connected,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        lastCycle: timers.managementLastRun || null,
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