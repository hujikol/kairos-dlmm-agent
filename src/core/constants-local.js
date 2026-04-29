/**
 * Operator overrides — per-instance tuning that should NOT be committed.
 *
 * Use this file to override values from constants.js without modifying the
 * canonical file. Useful for experimentation, emergency overrides, or
 * instance-specific tuning during live operation.
 *
 * This file is .gitignored. Copy constants.js values here and override as needed.
 */

import { config } from "../config.js";

// ─── Token / wallet ──────────────────────────────────────────────
export const TOKEN_SWAP_MIN_BALANCE = 0.01;  // skip tokens with <$0.01 in wallet

// ─── Telegram ────────────────────────────────────────────────────
export const MAX_TELEGRAM_QUEUE = 5;         // max queued Telegram messages while busy

// ─── Derived from config ──────────────────────────────────────────
export const DEPLOY = config.management.deployAmountSol;

