import { SOL_MINT } from "../../constants.js";

/**
 * Normalize any SOL-like address to the canonical SOL_MINT constant.
 * Used everywhere mint addresses are resolved — prevents "SOL" vs wrapped-SOL mismatches.
 * @param {string} mint
 * @returns {string} Normalized mint address
 */
export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" ||
    mint === "native" ||
    /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}