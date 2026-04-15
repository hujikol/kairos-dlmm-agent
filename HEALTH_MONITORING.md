# Health Monitoring

The `/health` endpoint is the primary liveness probe for this agent. Two complementary
monitoring approaches are documented here: external uptime monitoring (Better Uptime)
and a self-hosted cron script for environments where the port is not externally reachable.

---

## The `/health` Endpoint

**URL:** `http://localhost:3030/health` (or `HEALTH_PORT` env var)

**Response (200 OK):**
```json
{
  "ok": true,
  "uptime": 86400.4,
  "memory": { "rss": 123456, "heapTotal": 45678, "heapUsed": 34567, "external": 1234 },
  "lastCycle": "2026-04-15T10:30:00.000Z",
  "positionCount": 2
}
```

**Response (non-200):** the agent is unresponsive.

**What it checks:** The endpoint calls `getMyPositions()` (Meteora RPC/API) to
confirm the agent can reach external services. A 200 response means the process
is alive AND can reach the RPC.

**No authentication is required** — the endpoint is public within the host.

---

## Option A — External Monitoring (Recommended: Better Uptime Free Tier)

Better Uptime's free plan allows one monitor with 1-minute interval and
email/PagerDuty/Slack alerting.

### Step 1 — Create account

1. Go to https://betterstack.co and sign up (GitHub/Google SSO is fastest).
2. Verify your email address.

### Step 2 — Add a monitor

1. In the Better Uptime dashboard, click **Add Monitor**.
2. **Monitor type:** HTTP(s)
3. **Friendly name:** `kairos-dllm-agent`
4. **URL:** `https://your-public-hostname:3030/health`
   - Replace `https://your-public-hostname` with the publicly reachable address
     of the machine running the agent (e.g. a domain you control, or an IP with
     firewall rules forwarding port 3030).
   - If you are using a reverse proxy (nginx, Caddy), point it at the local
     health endpoint instead.
5. **Monitoring interval:** 1 minute
6. **Request timeout:** 30 seconds
7. **HTTP method:** GET
8. **Expected status code:** 200
9. **Response contains:** `ok` (or just verify status code = 200)
10. **Monitor team:** select your team or "Personal"

### Step 3 — Configure alerting

1. Click **Create** to save the monitor.
2. Go to **Alerting → Alert Channels**.
3. Click **Add channel** and choose your preferred method:

| Method | Setup |
|--------|-------|
| Email | Enter your email address. Better Uptime sends a verification email. |
| Slack | Create an Incoming Webhook in Slack, paste the URL here. |
| PagerDuty | Connect your PagerDuty integration. |
| Telegram | Use a Telegram bot webhook via https://betterstack.co/community — search for "Better Stack Telegram" in the community integrations. |

4. Assign the alert channel to the `kairos-dllm-agent` monitor.

### Step 4 — Verify the monitor

Click **Run check now** on the monitor to trigger an immediate check.
Confirm it reports "Up" within a few seconds.

### Troubleshooting

- **Monitor shows "Down":** `curl -v http://your-host:3030/health` from an
  external machine to confirm port 3030 is reachable through your firewall/NAT.
- **Port not reachable:** Use a reverse proxy (nginx/Caddy) on port 443 or 80
  to proxy to `localhost:3030/health`.
- **Self-signed certificate:** Better Uptime supports HTTPS with self-signed
  certs if you enable "Ignore SSL errors" on the monitor (not recommended for
  production; use Let's Encrypt instead).

---

## Option B — Self-Hosted Cron Check

For servers where port 3030 is not externally exposed, use a local cron job
that runs a simple health-check script every minute.

### Prerequisites

- The agent must be running (`pm2 start ecosystem.config.js --name kairos`)
- `curl` or Node.js available on the host

### The check script

`scripts/health-check.js` calls `http://localhost:{HEALTH_PORT}/health`,
exits 0 on 200, exits 1 otherwise, and logs the result with a timestamp.

```js
/**
 * Health Check — self-hosted cron monitor
 *
 * Calls /health and exits 0 if the agent responds, 1 otherwise.
 * Logs each check with a timestamp to stdout.
 *
 * Usage:
 *   node scripts/health-check.js              — check once
 *
 * Cron (every minute):
 *   * * * * * cd /path/to/kairos && node scripts/health-check.js >> logs/health.log 2>&1
 *
 * The cron ensures this survives reboots (if you also run PM2 startup):
 *   pm2 save && pm2 startup
 */

import http from "http";

const PORT = parseInt(process.env.HEALTH_PORT || "3030", 10);
const HOST = process.env.HEALTH_HOST || "localhost";
const TIMEOUT_MS = 10_000;

function log(status, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${status}] ${message}`);
}

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
```

### Setup

1. **Save** the script as `scripts/health-check.js`.
2. **Test it manually:**
   ```bash
   node scripts/health-check.js
   # Expected output: [2026-04-15T10:30:00.000Z] [OK] up=86400s positions=2
   ```
3. **Add to crontab:**
   ```bash
   crontab -e
   ```
   Add this line:
   ```
   * * * * * cd /path/to/kairos && node scripts/health-check.js >> logs/health.log 2>&1
   ```
   Replace `/path/to/kairos` with the actual path to the repository.
4. **Create the log directory** if it does not exist:
   ```bash
   mkdir -p logs
   ```
5. **Verify cron is running:**
   ```bash
   grep HEALTH_PORT /etc/environment  # ensure env is available to cron
   # or prefix the cron line with a env var:
   # HEALTH_PORT=3030 node scripts/health-check.js >> logs/health.log 2>&1
   ```

### Alerting from cron

The `scripts/health-check.js` script exits non-zero on failure.
To get alerts, pipe failures to a notification channel:

```bash
# Send email on failure (requires sendmail or mail)
* * * * * cd /path/to/kairos && node scripts/health-check.js >> logs/health.log 2>&1 || echo "kairos health check failed at $(date)" | sendmail admin@example.com

# Or use Telegram to notify (requires curl):
* * * * * cd /path/to/kairos && node scripts/health-check.js >> logs/health.log 2>&1 || curl -s -X POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage -d chat_id=${TELEGRAM_CHAT_ID} -d text="kairos health check FAILED at $(date)" > /dev/null
```

---

## Security Considerations

### The `/health` endpoint requires no authentication

This is intentional — the endpoint is designed as a low-overhead liveness probe
with no secrets involved. However, be aware of what it exposes:

| Field | Sensitivity |
|-------|-------------|
| `positionCount` | Reveals how many positions the agent has open |
| `uptime` | Reveals how long the process has been running |
| `memory` | Reveals process memory consumption |
| `lastCycle` | Reveals agent activity timing |

**If you expose port 3030 externally**, anyone who can reach
`http://your-server:3030/health` can see the above data.

**Recommendations:**

- Do **not** expose port 3030 directly to the public internet without a reverse
  proxy that authenticates or rate-limits requests.
- If Better Uptime monitoring is required and port 3030 cannot be restricted,
  use a reverse proxy (nginx/Caddy) that either:
  - Allows unauthenticated access to `/health` only (deny all other paths), or
  - Uses HTTP Basic Auth or a secret header as a simple shared secret:
    ```
    # nginx example
    location /health {
      proxy_pass http://localhost:3030/health;
      # Require a secret header from Better Uptime
      proxy_set_header X-Monitor-Secret "your-secret-here";
    }
    ```
- If using the self-hosted cron approach, the endpoint never needs to be
  externally reachable — only `localhost:3030` is contacted.

---

## Deployment Checklist

When deploying the agent to a new server, include these monitoring steps:

- [ ] Health endpoint reachable at `localhost:3030/health`
- [ ] If external monitoring required: Better Uptime monitor created with 1-min interval
- [ ] If self-hosted monitoring required: `scripts/health-check.js` added to crontab
- [ ] Alert channel (email/Telegram/Slack) confirmed working with a test failure
- [ ] Port 3030 firewall rules reviewed — do not expose publicly without reverse proxy auth
