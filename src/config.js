import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

// ─── v1 → v2 migration ─────────────────────────────────────────────────────
const SECTION_MAP = {
  screening: [
    "minFeeActiveTvlRatio", "minOrganic", "minHolders", "minMcap", "maxMcap",
    "minTvl", "maxTvl", "minVolume", "minBinStep", "maxBinStep", "timeframe",
    "category", "minTokenFeesSol", "maxBundlePct", "maxBotHoldersPct",
    "maxTop10Pct", "blockedLaunchpads", "minTokenAgeHours", "maxTokenAgeHours",
    "athFilterPct", "slippageBps", "screeningCooldownMs", "balanceCacheTtlMs",
  ],
  management: [
    "minClaimAmount", "autoSwapAfterClaim", "autoSwapAfterClose",
    "outOfRangeBinsToClose", "outOfRangeWaitMinutes", "minVolumeToRebalance",
    "stopLossPct", "takeProfitFeePct", "minFeePerTvl24h", "minAgeBeforeYieldCheck",
    "minSolToOpen", "gasReserve", "baseDeployAmount", "maxDeployAmount",
    "trailingTakeProfit", "trailingTriggerPct", "trailingDropPct", "solMode",
    "deployAmountSol", "pnlSuspectThresholdPct", "pnlSuspectMinUsd",
    "yieldCheckMinAgeMs", "minLlmOutputLen", "maxLlmOutputDisplay",
    "telegramMaxMsgLen",
  ],
  risk: [
    "maxPositions", "dailyProfitTarget", "dailyLossLimit", "maxPositionsPerToken",
  ],
  schedule: [
    "managementIntervalMin", "screeningIntervalMin",
  ],
  llm: [
    "temperature", "maxTokens", "maxSteps", "screenerMaxSteps", "managerMaxSteps",
    "managementModel", "screeningModel", "generalModel",
  ],
  strategy: [
    "strategy", "binsBelow",
  ],
  okx: [
    "okxApiTimeoutMs",
  ],
};

function migrateConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch (err) {
    log("warn", "config", `migrateConfig: failed to parse user-config.json — skipping migration: ${err?.message}`);
    return;
  }

  // Already v2 — all known keys are nested under their section, or file is empty
  const hasAnySection = Object.keys(SECTION_MAP).some((s) => cfg[s] !== undefined);
  if (hasAnySection) return;

  // Detect flat v1 keys present at root level
  const v1KeysPresent = Object.keys(cfg).filter((k) =>
    Object.values(SECTION_MAP).flat().includes(k)
  );
  if (v1KeysPresent.length === 0) return;

  // Wrap flat keys under their appropriate section
  for (const [section, keys] of Object.entries(SECTION_MAP)) {
    migrated[section] = {};
    for (const key of keys) {
      if (cfg[key] !== undefined) migrated[section][key] = cfg[key];
    }
    if (Object.keys(migrated[section]).length === 0) delete migrated[section];
  }

  // Carry forward top-level keys that are not sectioned (rpcUrl, walletKey, etc.)
  const SECTIONED_KEYS = new Set(Object.values(SECTION_MAP).flat());
  for (const [k, v] of Object.entries(cfg)) {
    if (!SECTIONED_KEYS.has(k)) migrated[k] = v;
  }

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(migrated, null, 2), "utf8");
  log("info", "config", `migrated user-config.json from v1 to v2 (${v1KeysPresent.join(", ")})`);
}

migrateConfig();

// Load migrated (or already-v2) config
const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)     process.env.RPC_URL            ??= u.rpcUrl;
if (u.walletKey)  process.env.WALLET_PRIVATE_KEY ??= u.walletKey;
if (u.llmModel)   process.env.LLM_MODEL          ??= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL       ??= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY        ??= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN  ??= String(u.dryRun);

import { SOL_MINT, USDC_MINT, USDT_MINT } from "./constants.js";

/** Returns true if DRY_RUN is enabled. Use this instead of inline process.env comparisons. */
export function isDryRun() {
  return process.env.DRY_RUN === "true";
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:        u.risk?.maxPositions        ?? u.maxPositions        ?? 3,
    dailyProfitTarget:   u.risk?.dailyProfitTarget   ?? u.dailyProfitTarget   ?? 2,
    dailyLossLimit:      u.risk?.dailyLossLimit      ?? u.dailyLossLimit      ?? -5,
    maxPositionsPerToken: u.risk?.maxPositionsPerToken ?? u.maxPositionsPerToken ?? 1,
  },

  // ─── Pool Screening Thresholds ─ v2 nested thresholds support ───────────
  // Supports both flat keys (v1) and nested thresholds object (v2):
  //   flat:    { "minFeeActiveTvlRatio": 0.05, "minTvl": 10000 }
  //   nested:  { "thresholds": { "minFeeActiveTvlRatio": 0.05, "minTvl": 10000 } }
  screening: {
    minFeeActiveTvlRatio: u.thresholds?.minFeeActiveTvlRatio ?? u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.thresholds?.minTvl            ?? u.minTvl            ?? 10_000,
    maxTvl:            u.thresholds?.maxTvl            ?? u.maxTvl            ?? 150_000,
    minVolume:         u.thresholds?.minVolume         ?? u.minVolume         ?? 500,
    minOrganic:        u.thresholds?.minOrganic        ?? u.minOrganic        ?? 60,
    minHolders:        u.thresholds?.minHolders        ?? u.minHolders        ?? 500,
    minMcap:           u.thresholds?.minMcap           ?? u.minMcap           ?? 150_000,
    maxMcap:           u.thresholds?.maxMcap           ?? u.maxMcap           ?? 10_000_000,
    minBinStep:        u.thresholds?.minBinStep        ?? u.minBinStep        ?? 80,
    maxBinStep:        u.thresholds?.maxBinStep        ?? u.maxBinStep        ?? 125,
    timeframe:         u.thresholds?.timeframe         ?? u.timeframe         ?? "5m",
    category:          u.thresholds?.category          ?? u.category          ?? "trending",
    minTokenFeesSol:   u.thresholds?.minTokenFeesSol   ?? u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct:      u.thresholds?.maxBundlePct      ?? u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.thresholds?.maxBotHoldersPct  ?? u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.thresholds?.maxTop10Pct       ?? u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads:  u.thresholds?.blockedLaunchpads  ?? u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.thresholds?.minTokenAgeHours   ?? u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.thresholds?.maxTokenAgeHours   ?? u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.thresholds?.athFilterPct       ?? u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    // ─── Operational tunables ───────────────────────
    slippageBps:        u.screening?.slippageBps        ?? 300,
    screeningCooldownMs: u.screening?.screeningCooldownMs ?? 300_000,
    balanceCacheTtlMs:  u.screening?.balanceCacheTtlMs ?? 300_000,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.management?.minClaimAmount        ?? u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.management?.autoSwapAfterClaim    ?? u.autoSwapAfterClaim    ?? false,
    autoSwapAfterClose:    u.management?.autoSwapAfterClose    ?? u.autoSwapAfterClose    ?? true,
    outOfRangeBinsToClose: u.management?.outOfRangeBinsToClose ?? u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.management?.outOfRangeWaitMinutes ?? u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.management?.minVolumeToRebalance  ?? u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.management?.stopLossPct           ?? u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.management?.takeProfitFeePct      ?? u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.management?.minFeePerTvl24h       ?? u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.management?.minAgeBeforeYieldCheck ?? u.minAgeBeforeYieldCheck ?? 60,
    minSolToOpen:          u.management?.minSolToOpen          ?? u.minSolToOpen          ?? 0.55,
    gasReserve:            u.management?.gasReserve            ?? u.gasReserve            ?? 0.2,
    baseDeployAmount:      u.management?.baseDeployAmount      ?? u.deployAmountSol   ?? u.baseDeployAmount ?? 0.35,
    deployAmountSol:       u.management?.deployAmountSol       ?? u.deployAmountSol   ?? u.baseDeployAmount ?? 0.35,
    maxDeployAmount:       u.management?.maxDeployAmount       ?? u.maxDeployAmount       ?? 50,
    trailingTakeProfit:    u.management?.trailingTakeProfit    ?? u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.management?.trailingTriggerPct    ?? u.trailingTriggerPct    ?? 3,
    trailingDropPct:       u.management?.trailingDropPct       ?? u.trailingDropPct       ?? 1.5,
    solMode:               u.management?.solMode               ?? u.solMode               ?? false,
    pnlSuspectThresholdPct: u.management?.pnlSuspectThresholdPct ?? 100,
    pnlSuspectMinUsd:       u.management?.pnlSuspectMinUsd       ?? 1,
    yieldCheckMinAgeMs:     u.management?.yieldCheckMinAgeMs     ?? 86_400_000,
    minLlmOutputLen:        u.management?.minLlmOutputLen        ?? 5,
    maxLlmOutputDisplay:    u.management?.maxLlmOutputDisplay    ?? 2000,
    telegramMaxMsgLen:      u.management?.telegramMaxMsgLen      ?? 4096,
  },

  // ─── OKX ────────────────────────────────
  okx: {
    okxApiTimeoutMs: u.okx?.okxApiTimeoutMs ?? 12_000,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy?.strategy  ?? u.strategy  ?? "bid_ask",
    binsBelow: u.strategy?.binsBelow ?? u.binsBelow ?? 69,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.schedule?.managementIntervalMin  ?? (isDryRun() ? 1 : 10),
    screeningIntervalMin:   u.schedule?.screeningIntervalMin   ?? (isDryRun() ? 1 : 30),
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.llm?.temperature ?? u.temperature ?? 0.373,
    maxTokens:   u.llm?.maxTokens   ?? u.maxTokens   ?? 4096,
    maxSteps:    u.llm?.maxSteps    ?? u.maxSteps    ?? 10,
    screenerMaxSteps: u.llm?.screenerMaxSteps ?? u.screenerMaxSteps ?? 5,
    managerMaxSteps:  u.llm?.managerMaxSteps  ?? u.managerMaxSteps  ?? 4,
    managementModel: u.llm?.models?.manager  ?? u.llm?.managementModel ?? u.models?.manager ?? u.managementModel ?? process.env.LLM_MODEL ?? "minimax/minimax-01",
    screeningModel:  u.llm?.models?.screener ?? u.llm?.screeningModel ?? u.models?.screener ?? u.screeningModel  ?? process.env.LLM_MODEL ?? "minimax/minimax-01",
    generalModel:    u.llm?.models?.general ?? u.llm?.generalModel ?? u.models?.general ?? u.generalModel    ?? process.env.LLM_MODEL ?? "minimax/minimax-01",
    evolveModel:     u.llm?.models?.evolve  ?? u.llm?.evolveModel ?? process.env.LLM_MODEL ?? "minimax/minimax-01",
  },


  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  SOL_MINT,
    USDC: USDC_MINT,
    USDT: USDT_MINT,
  },
};

export const DEFAULT_LLM_MODEL = "hermes-3-405b";

/**
 * Conviction Sizing Matrix — fixed position sizing based on conviction level
 * and number of open positions. 3x sizing (very_high) only when 0 positions open.
 *
 * | Positions | Conviction | Amount    |
 * |-----------|------------|-----------|
 * | 0         | very_high  | 1.05 SOL  |
 * | 1+        | very_high  | 0.70 SOL  |
 * | any       | high       | 0.53 SOL  |
 * | any       | normal     | 0.35 SOL  |
 *
 * Amounts are clamped to wallet balance minus gasReserve.
 */
const SIZING_MATRIX = {
  very_high: { 0: 1.05, other: 0.70 },
  high:      { any: 0.53 },
  normal:    { any: 0.35 },
};

export function computeDeployAmount(walletSol, openPositions = 0, conviction = "normal") {
  const reserve  = config.management.gasReserve  ?? 0.2;
  const deployable = Math.max(0, walletSol - reserve);
  if (deployable <= 0) return { amount: 0, error: "Insufficient SOL after gas reserve" };

  const level = SIZING_MATRIX[conviction] ?? SIZING_MATRIX.normal;
  // For very_high: use 1.05 if 0 positions, otherwise 0.70
  const target = level[openPositions] ?? level.other ?? level.any;

  const ceil = Math.min(config.management.maxDeployAmount, deployable);
  const amount = Math.min(ceil, target);
  if (amount < 0.1) return { amount: 0, error: `Insufficient SOL: only ${deployable.toFixed(2)} SOL available after reserve` };

  return { amount: parseFloat(amount.toFixed(2)), error: null };
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));

    for (const [section, keys] of Object.entries(SECTION_MAP)) {
      if (!config[section]) continue;
      for (const key of keys) {
        // Prefer v2 nested path; fall back to flat v1 key for backward compatibility
        if (fresh[section]?.[key] !== undefined) {
          config[section][key] = fresh[section][key];
        } else if (fresh[key] !== undefined) {
          config[section][key] = fresh[key];
        }
      }
    }
  } catch (err) {
    // Thresholds are reloaded every management cycle — failure here just means
    // the next cycle will retry. Log at warn level so it's observable but not noisy.
    log("warn", "config", `reloadScreeningThresholds: ignoring error (will retry next cycle): ${err?.message}`);
  }
}
