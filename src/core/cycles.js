/**
 * cycles.js — backward-compatibility re-export barrel.
 *
 * All actual cycle logic has been moved to focused modules:
 *   management-cycle.js  — runManagementCycle
 *   screening-cycle.js   — runScreeningCycle
 *   management-helpers.js — deterministic rules, report builders
 *   screening-helpers.js — candidate reconstitution, filters, block builder
 *   cycle-helpers.js     — shared: escapeHTMLLocal, computeBinsBelow
 *   agent-gateway.js     — AgentGateway facade (mockable in tests)
 *
 * Existing importers (index.js, watchdog.js, telegram-handlers.js,
 * scheduler.js) continue to work without changes.
 */

// Re-export cycle entry points
export { runManagementCycle } from "./management-cycle.js";
export { runScreeningCycle } from "./screening-cycle.js";

// Re-export shared helpers (used by telegram-handlers.js)
export { escapeHTMLLocal } from "./cycle-helpers.js";
