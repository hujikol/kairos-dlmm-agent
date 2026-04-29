import * as Sentry from "@sentry/node";
import { log } from "./core/logger.js";

export async function initSentry() {
  if (!process.env.SENTRY_DSN) return; // Sentry disabled if no DSN
  const integrations = [
    Sentry.captureConsoleIntegration({ levels: ["log", "warn", "error"] }),
  ];
  let profilesSampleRate = parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? "0.1");

  try {
    const { nodeProfilingIntegration } = await import("@sentry/profiling-node");
    integrations.unshift(nodeProfilingIntegration());
  } catch (e) {
    profilesSampleRate = 0;
    log("warn", "sentry", `CPU profiling disabled: ${e?.message ?? e}`);
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    profilesSampleRate,
    enableLogs: true,
  });
}

export function captureError(err, context = {}) {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(err, { extra: context });
}

/**
 * Send a Sentry alert for emergency conditions (no Error object needed).
 * Use for: circuit breaker halts, emergency closes, panic events.
 */
export function captureAlert(message, context = {}) {
  if (!Sentry.isInitialized()) {
    log("error", "alert", message, { ...context });
    return;
  }
  Sentry.captureMessage(message, { level: "error", extra: context });
}
