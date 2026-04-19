/**
 * Shared readline interface and prompt builder.
 * rl is created in index.js (inside isTTY block) and used by telegram-handlers.js.
 * buildPrompt uses scheduler state and is needed by both index.js (for the TTY prompt
 * refresh interval) and telegram-handlers.js (in telegramHandler's finally block).
 */

import { config } from "./config.js";
import { formatCountdown, nextRunIn } from "./core/scheduler.js";
import { timers } from "./core/state/scheduler-state.js";

export let rl = null;

export function setRl(readlineInterface) {
  rl = readlineInterface;
}

export function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}
