/**
 * Local constants not yet in constants.js.
 * Duplicates of constants.js values: import from constants.js instead.
 */

import { config } from "../config.js";

// ─── Token / wallet ──────────────────────────────────────────────
export const TOKEN_SWAP_MIN_BALANCE = 0.01;  // skip tokens with <$0.01 in wallet

// ─── Telegram ────────────────────────────────────────────────────
export const MAX_TELEGRAM_QUEUE = 5;         // max queued Telegram messages while busy

// ─── Derived from config ──────────────────────────────────────────
export const DEPLOY = config.management.deployAmountSol;

