/**
 * Shared helpers used by both management and screening cycles.
 */

// ─── HTML escaper ─────────────────────────────────────────────────────────────

export function escapeHTMLLocal(text) {
  if (!text) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── bins_below computation (used in screening cycle prompt) ─────────────────

/**
 * Compute bins_below from pool volatility.
 * Formula: round(35 + (volatility / 5) * 34), clamped to [35, 69]
 */
export function computeBinsBelow(volatility) {
  const raw = Math.round(35 + (volatility / 5) * 34);
  return Math.min(69, Math.max(35, raw));
}
