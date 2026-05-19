import { getDB } from "./db.js";
import { config as globalConfig, USER_CONFIG_PATH, reloadScreeningThresholds } from "../config.js";
import { log } from "./logger.js";
import { sendHTML } from "../notifications/telegram.js";
import fs from "fs";

function loadUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return globalConfig;
  return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
}

function saveUserConfig(cfg) {
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  reloadScreeningThresholds();
}

const HALLUCINATION_THRESHOLD = 3;
const CONSECUTIVE_FAIL_THRESHOLD = 3;
const WINDOW_MS = 10 * 60 * 1000;

const _hallucinationHistory = [];
const _consecutiveFailHistory = [];
let _active = null;

function isActive() {
  if (_active !== null) return _active;
  _active = loadUserConfig().safety?.safeModeActive === true;
  return _active;
}

export function recordHallucination() {
  const now = Date.now();
  _hallucinationHistory.push(now);
  const recent = _hallucinationHistory.filter(t => now - t < WINDOW_MS);
  recent.length = Math.min(recent.length, HALLUCINATION_THRESHOLD);
  if (recent.length >= HALLUCINATION_THRESHOLD) {
    activate("hallucination_spike");
  }
}

export function recordDeployFailure() {
  const now = Date.now();
  _consecutiveFailHistory.push(now);
  const recent = _consecutiveFailHistory.filter(t => now - t < WINDOW_MS);
  recent.length = Math.min(recent.length, CONSECUTIVE_FAIL_THRESHOLD);
  if (recent.length >= CONSECUTIVE_FAIL_THRESHOLD) {
    activate("consecutive_deploy_failures");
  }
}

export function isSafeModeActive() {
  return isActive();
}

export function activate(reason) {
  if (isActive()) return;
  _active = true;
  const config = loadUserConfig();
  config.safety = config.safety || {};
  config.safety.safeModeActive = true;
  config.safety.safeModeReason = reason;
  config.safety.safeModeSince = Date.now();
  saveUserConfig(config);
  log("warn", "safe-mode", `SAFE MODE ACTIVATED: ${reason}`);
  sendHTML(`<b>🚨 Safe Mode Activated</b>\nReason: ${reason}\nDeploys blocked until manually reset.`);
}

export function deactivate() {
  if (!isActive()) return;
  _active = false;
  const config = loadUserConfig();
  config.safety = config.safety || {};
  config.safety.safeModeActive = false;
  saveUserConfig(config);
  log("info", "safe-mode", "SAFE MODE DEACTIVATED by manual reset");
  sendHTML("<b>✅ Safe Mode Deactivated</b>\nDeploys re-enabled.").catch(() => {});
}