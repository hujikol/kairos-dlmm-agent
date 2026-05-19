import { isSafeModeActive, deactivate } from "../../core/safe-mode.js";
import { USER_CONFIG_PATH } from "../../config.js";
import fs from "fs";

function loadUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
}

export async function handleSafeModeCommand(args, replyFn) {
  if (args[0] === "status") {
    const active = isSafeModeActive();
    const reason = loadUserConfig().safety?.safeModeReason;
    const since = loadUserConfig().safety?.safeModeSince;
    const sinceStr = since ? new Date(since).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : null;
    const msg = `Safe mode: ${active ? "ACTIVE" : "OFF"}\n${active && reason ? `Reason: ${reason}${sinceStr ? `\nSince: ${sinceStr}` : ""}` : ""}`;
    return replyFn(msg);
  }
  if (args[0] === "off" || args[0] === "disable") {
    deactivate();
    return replyFn("Safe mode deactivated. Deploys re-enabled.");
  }
  return replyFn("Usage: /safe-mode [status|off]");
}