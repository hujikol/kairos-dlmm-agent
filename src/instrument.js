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
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
    enableLogs: true,
  });
}

export function captureError(err, context = {}) {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(err, { extra: context });
}