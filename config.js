// Root-level shim — re-export from canonical location (src/config.js)
// Previously lived at project root; now lives at src/config.js.
// All imports that use "../../config.js" or "../config.js" from files at
// depth >= 2 will resolve here. Single-level "../config.js" imports
// (from src/core/*, src/integrations/*) resolve directly to src/config.js.
export * from "./src/config.js";