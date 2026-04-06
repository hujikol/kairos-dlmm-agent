import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:        u.maxPositions        ?? 3,
    dailyProfitTarget:   u.dailyProfitTarget   ?? 2,      // $2/day minimum
    dailyLossLimit:      u.dailyLossLimit      ?? -5,     // -$5/day stop trading
    maxPositionsPerToken: u.maxPositionsPerToken ?? 1,     // max open positions per token
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapAfterClose:    u.autoSwapAfterClose    ?? true,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    gasReserve:            u.gasReserve            ?? 0.2,
    baseDeployAmount:      u.deployAmountSol   ?? u.baseDeployAmount ?? 0.35,
    deployAmountSol:       u.deployAmountSol   ?? u.baseDeployAmount ?? 0.35,
    maxDeployAmount:       u.maxDeployAmount       ?? 50,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 10,
    screenerMaxSteps: u.screenerMaxSteps ?? 5,
    managerMaxSteps:  u.managerMaxSteps  ?? 4,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

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

    // ── Section-to-key mapping: which user-config keys belong to which config section ──
    const SECTION_MAP = {
      screening: [
        "minFeeActiveTvlRatio", "minOrganic", "minHolders", "minMcap", "maxMcap",
        "minTvl", "maxTvl", "minVolume", "minBinStep", "maxBinStep", "timeframe",
        "category", "minTokenFeesSol", "maxBundlePct", "maxBotHoldersPct",
        "maxTop10Pct", "blockedLaunchpads", "minTokenAgeHours", "maxTokenAgeHours",
        "athFilterPct",
      ],
      management: [
        "minClaimAmount", "autoSwapAfterClaim", "autoSwapAfterClose",
        "outOfRangeBinsToClose", "outOfRangeWaitMinutes", "minVolumeToRebalance",
        "stopLossPct", "takeProfitFeePct", "minFeePerTvl24h", "minAgeBeforeYieldCheck",
        "minSolToOpen", "gasReserve", "baseDeployAmount", "maxDeployAmount",
        "trailingTakeProfit", "trailingTriggerPct", "trailingDropPct", "solMode",
        "deployAmountSol",
      ],
      risk: [
        "maxPositions", "dailyProfitTarget", "dailyLossLimit", "maxPositionsPerToken",
      ],
      schedule: [
        "managementIntervalMin", "screeningIntervalMin",
      ],
      llm: [
        "temperature", "maxTokens", "maxSteps", "screenerMaxSteps", "managerMaxSteps",
        "managementModel", "screeningModel", "generalModel", "maxWallSeconds",
      ],
      strategy: [
        "strategy", "binsBelow",
      ],
    };

    for (const [section, keys] of Object.entries(SECTION_MAP)) {
      for (const key of keys) {
        if (fresh[key] !== undefined) {
          config[section][key] = fresh[key];
        }
      }
    }
  } catch { /* ignore */ }
}
