// Backward-compatibility re-export.
// The canonical logging modules live in src/core/logging/.
// This file ensures existing importers (e.g., src/tools/executor.js) keep working
// without path changes.
export {
  log,
  logInfo,
  logWarn,
  logError,
  logDebug,
  logAction,
  logSnapshot,
} from "./logging/index.js";
