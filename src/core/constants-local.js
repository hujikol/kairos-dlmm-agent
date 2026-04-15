/**
 * Local constants extracted from index.js.
 * These are threshold/tuning values used within index.js and its orchestration layer.
 */

import { config } from "../config.js";

// ─── PnL sanity-check ────────────────────────────────────────────
export const PNL_SUSPECT_PCT = 100;            // flag PnL > 100% as suspect (API bad data)
export const PNL_SUSPECT_USD = 1;             // minimum USD value for inner suspect check

// ─── Position / yield rules ──────────────────────────────────────
export const MIN_POSITION_AGE_FOR_YIELD_CHECK_MS = 86_400_000; // 24 h in ms → yields rule applies after 24 min

// ─── Screening ───────────────────────────────────────────────────
export const SCREENING_COOLDOWN_MS = 300_000; // 5-minute cooldown between screenings

// ─── Token / wallet ──────────────────────────────────────────────
export const TOKEN_SWAP_MIN_BALANCE = 0.01;  // skip tokens with <$0.01 in wallet

// ─── LLM output ───────────────────────────────────────────────────
export const MIN_LLM_OUTPUT_LEN = 5;         // discard LLM output shorter than this
export const MAX_LLM_OUTPUT_DISPLAY = 2000;  // truncate LLM output in reports beyond this

// ─── Telegram ────────────────────────────────────────────────────
export const MAX_HTML_MSG_LEN = 4096;         // Telegram message length cap
export const MAX_TELEGRAM_QUEUE = 5;         // max queued Telegram messages while busy

// ─── Derived from config ──────────────────────────────────────────
export const DEPLOY = config.management.deployAmountSol;

