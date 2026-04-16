import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

export function initSentry() {
  if (!process.env.SENTRY_DSN) return; // Sentry disabled if no DSN
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      nodeProfilingIntegration(),
      Sentry.captureConsoleIntegration({ levels: ["log", "warn", "error"] }),
    ],
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.1'),
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