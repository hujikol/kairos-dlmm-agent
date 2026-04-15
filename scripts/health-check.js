/**
 * Health Check — self-hosted cron monitor
 *
 * Calls /health and exits 0 if the agent responds with 200, 1 otherwise.
 * Logs each check with a timestamp to stdout.
 *
 * Usage:
 *   node scripts/health-check.js              — check once
 *
 * Cron (every minute):
 *   * * * * * cd /path/to/kairos && node scripts/health-check.js >> logs/health.log 2>&1
 *
 * The cron entry survives reboots if PM2 startup is configured:
 *   pm2 save && pm2 startup
 */

import http from "http";

const PORT = parseInt(process.env.HEALTH_PORT || "3030", 10);
const HOST = process.env.HEALTH_HOST || "localhost";
const TIMEOUT_MS = 10_000;

/**
 * @param {"OK"|"FAIL"} status
 * @param {string} message
 */
function log(status, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${status}] ${message}`);
}

/**
 * @returns {Promise<number>} exit code (0 = healthy, 1 = unhealthy)
 */
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: HOST, port: PORT, path: "/health", timeout: TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200) {
            let parsed;
            try { parsed = JSON.parse(body); } catch { /* ok */ }
            const pos = parsed?.positionCount ?? "unknown";
            const uptime = parsed?.uptime?.toFixed(0) ?? "unknown";
            log("OK", `up=${uptime}s positions=${pos}`);
            resolve(0);
          } else {
            log("FAIL", `HTTP ${res.statusCode}`);
            resolve(1);
          }
        });
      }
    );

    req.on("error", (err) => {
      log("FAIL", `connection error: ${err.message}`);
      resolve(1);
    });

    req.on("timeout", () => {
      req.destroy();
      log("FAIL", "connection timed out");
      resolve(1);
    });
  });
}

const exitCode = await checkHealth();
process.exit(exitCode);
