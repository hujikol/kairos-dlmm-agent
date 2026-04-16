/**
 * Circuit breaker state machine for external API integrations.
 *
 * States:
 *   CLOSED    — normal operation, failures count toward threshold
 *   OPEN      — fast-fail mode, immediately rejects calls after N failures
 *   HALF_OPEN — probe mode, allows limited requests to test recovery
 *
 * Transitions:
 *   CLOSED → OPEN   after `failureThreshold` consecutive failures
 *   OPEN   → HALF_OPEN after `recoveryTimeoutMs` elapses
 *   HALF_OPEN → CLOSED if probe succeeds (recordSuccess)
 *   HALF_OPEN → OPEN   if probe fails or probes exhausted
 */

export const CircuitBreakerState = {
  CLOSED:      "closed",
  OPEN:        "open",
  HALF_OPEN:   "half_open",
};

export class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit breaker '${name}' is OPEN`);
    this.name = "CircuitOpenError";
  }
}

export function createCircuitBreaker(name, options = {}) {
  const {
    failureThreshold  = 5,
    recoveryTimeoutMs = 60_000,
    halfOpenProbes    = 3,
  } = options;

  let state         = CircuitBreakerState.CLOSED;
  let failures      = 0;
  let lastFailureAt = null;
  let probesUsed    = 0;
  let openAt        = null;   // timestamp when we transitioned to OPEN

  // ─── State accessors ───────────────────────────────────────────

  function isClosed()   { return state === CircuitBreakerState.CLOSED; }
  function isOpen()     { return state === CircuitBreakerState.OPEN; }
  function isHalfOpen() { return state === CircuitBreakerState.HALF_OPEN; }

  // ─── Automatic transition OPEN → HALF_OPEN ─────────────────────
  function _checkAutoOpen() {
    if (isOpen() && openAt !== null) {
      if (Date.now() - openAt >= recoveryTimeoutMs) {
        state     = CircuitBreakerState.HALF_OPEN;
        probesUsed = 0;
      }
    }
  }

  // ─── Probe permission (HALF_OPEN only) ─────────────────────────
  function isProbeAllowed() {
    _checkAutoOpen();
    if (!isHalfOpen()) return false;
    return probesUsed < halfOpenProbes;
  }

  function isOpenFastFail() {
    _checkAutoOpen();
    if (isOpen()) return true;
    // In HALF_OPEN, fast-fail once probes are exhausted
    if (isHalfOpen() && probesUsed >= halfOpenProbes) return true;
    return false;
  }

  // ─── Record outcome ─────────────────────────────────────────────
  function recordSuccess() {
    _checkAutoOpen();
    if (isHalfOpen()) {
      // Successful probe → close the circuit
      state     = CircuitBreakerState.CLOSED;
      failures  = 0;
      openAt    = null;
      probesUsed = 0;
    } else if (isClosed()) {
      // Reset on normal success
      failures = 0;
    } else {
      probesUsed++;
    }
  }

  function recordFailure() {
    _checkAutoOpen();

    if (isHalfOpen()) {
      probesUsed++;
      if (probesUsed >= halfOpenProbes) {
        // All probes failed → trip back to OPEN
        state = CircuitBreakerState.OPEN;
        openAt = Date.now();
        probesUsed = 0;
      }
      return;
    }

    if (isClosed()) {
      failures++;
      lastFailureAt = Date.now();
      if (failures >= failureThreshold) {
        state  = CircuitBreakerState.OPEN;
        openAt = Date.now();
      }
    }
  }

  return {
    name,
    isOpen:        isOpenFastFail,
    isHalfOpen:    () => { _checkAutoOpen(); return isHalfOpen(); },
    isProbeAllowed,
    recordSuccess,
    recordFailure,
    getState:      () => { _checkAutoOpen(); return state; },
    getFailures:   () => failures,
  };
}