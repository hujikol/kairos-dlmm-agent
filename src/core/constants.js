/**
 * Centralized magic numbers and tuning constants.
 * All hardcoded numeric values that could benefit from named identification.
 */

// ─── Simulator / IL Model ────────────────────────────────────────
export const MIN_DAILY_ROI    = 0.02;  // 2% daily ROI gate in simulatePoolDeploy
export const IL_RISK_HIGH     = 0.08;  // annualized IL at volatility > 3
export const IL_RISK_MED      = 0.04;  // annualized IL at 1.5 < volatility <= 3
export const IL_RISK_LOW       = 0.02;  // annualized IL at volatility <= 1.5
export const VOL_BREAK_HIGH    = 3;     // volatility breakpoint: high risk
export const VOL_BREAK_MED    = 1.5;   // volatility breakpoint: medium risk

// Confidence increments
export const CONF_BASELINE     = 50;   // baseline confidence score
export const CONF_AGE_48H      = 30;   // bonus when age >= 48h
export const CONF_AGE_12H      = 15;   // bonus when 12h <= age < 48h
export const CONF_LOW_VOL      = 10;   // bonus when volatility < 1.5
export const CONF_FEE_TVL_RATIO= 10;   // bonus when fee_active_tvl_ratio >= 0.1

// Risk score increments
export const RISK_NO_AGE      = 25;   // age < 12h
export const RISK_HIGH_VOL     = 20;   // volatility > 3
export const RISK_HIGH_RISK    = 15;   // pool.risk_level === "high"
export const RISK_BUNDLE_30    = 15;   // bundle_pct > 30
export const RISK_LOW_ORGANIC  = 25;   // organic_score < 60

// ─── Meteora / Positions ─────────────────────────────────────────
export const CLAIM_DEDUP_MS    = 60_000; // 60-second window to skip re-claiming fees

// ─── Timeouts (ms) ─────────────────────────────────────────
export const WATCHDOG_POLL_INTERVAL_MS     = 60_000;
export const LLM_TIMEOUT_MS               = 300_000;
export const RETRY_DELAY_MS                = 5_000;
export const SOLANA_BACKOFF_BASE_DELAY_MS  = 1_000;
export const SOLANA_BACKOFF_MAX_DELAY_MS   = 30_000;
export const TELEGRAM_POLL_TIMEOUT_MS      = 35_000;
export const TELEGRAM_MSG_DELAY_MS         = 500;
export const HIVE_MIND_SYNC_DEBOUNCE_MS    = 300_000;
export const HIVE_MIND_GET_TIMEOUT_MS      = 5_000;
export const HIVE_MIND_POST_TIMEOUT_MS     = 10_000;
export const PNL_TIMEOUT_MS               = 8_000;
export const METEORA_CLOSE_SYNC_WAIT_MS    = 15_000;
export const METEORA_CLOSE_RETRY_DELAY_MS  = 3_000;
export const METEORA_POSITIONS_CACHE_TTL_MS = 300_000;
export const PNL_SUSPECT_PCT  = 100;   // flag PnL > 100% as suspect (API bad data)
export const PNL_SUSPECT_USD  = 1;     // minimum USD value for inner suspect check

// ─── Position Age & Yield ─────────────────────────────────────────
export const MIN_POSITION_AGE_FOR_YIELD_CHECK_MS = 86_400_000; // 24 hours in ms

// ─── Screener ─────────────────────────────────────────────────────
export const SCREENING_COOLDOWN_MS = 300_000; // 5-minute cooldown between scans

// ─── LLM Output ───────────────────────────────────────────────────
export const MIN_LLM_OUTPUT_LEN     = 5;
export const MAX_LLM_OUTPUT_DISPLAY = 2000;
export const MAX_HTML_MSG_LEN       = 4096;

// ─── Agent Loop ───────────────────────────────────────────────────
export const LOOP_TIMEOUT_MS = 120_000; // 2 minutes wall-clock per step

// ─── Gas ──────────────────────────────────────────────────────────
export const GAS_COST_PER_TX_SOL = 0.01; // 0.005 * 2 for deploy + close

// ─── Price Formatting ──────────────────────────────────────────────
export const PRICE_FORMAT_THRESHOLD = 0.0001; // below this, use toExponential(3); else toFixed(6)

// ─── Darwin Weights ───────────────────────────────────────────────
export const DARWIN_BOOST_FACTOR    = 0.25;  // weight boost for top-quartile signals
export const DARWIN_DECAY_FACTOR    = 0.75;  // weight decay for bottom-quartile signals
export const DARWIN_WEIGHT_FLOOR    = 1.05;  // minimum signal weight
export const DARWIN_WEIGHT_CEILING  = 0.95;  // maximum signal decay (NOT ceiling — floor for decay)
export const DARWIN_RARITY_BOOST    = 0.3;   // rarity bonus multiplier
export const DARWIN_VOLUME_FACTOR   = 2.5;   // volume signal multiplier

// ─── Post-Mortem Thresholds ─────────────────────────────────────────
export const WIN_RATE_THRESHOLD     = 0.33;  // win rate below this triggers AVOID_PATTERN (postmortem.js line 236)
export const FREQUENCY_THRESHOLD    = 0.6;   // failure frequency above this triggers RECURRING_FAILURE (postmortem.js line 272)

// ─── External Integrations ─────────────────────────────────────────
export const OKX_ENRICHMENT_TIMEOUT_MS = 60_000;  // OKX enrichment timeout (discovery.js line 172)
export const BALANCE_CACHE_AGE_MS       = 30_000;  // balance cache max age (executor.js line 180)
export const SLIPPAGE_BPS               = 300;      // default slippage in basis points (helius/swaps.js line 14)
export const TOKEN_AGE_MS_PER_HOUR      = 3_600_000; // ms per hour for token age calculation (discovery.js line 45)

// ─── Loss Streak ───────────────────────────────────────────────────
export const DEFAULT_LOSS_STREAK_THRESHOLD = 3;
export const DEFAULT_LOSS_STREAK_MIN_PNL_PCT = -1.0;
export const DEFAULT_LOSS_STREAK_MIN_AGE_CYCLES = 2;
