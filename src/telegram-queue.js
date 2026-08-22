const READ_ONLY_COMMANDS = new Set(["/balance", "/status", "/positions", "/thresholds", "/candidates"]);

export function isReadOnlyTelegramCommand(text) {
  return READ_ONLY_COMMANDS.has(text);
}
