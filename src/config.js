import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./core/logger.js";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "./constants.js";
import { GAS_RESERVE_DEFAULT, BASE_DEPLOY_AMOUNT_DEFAULT, DEPLOY_AMOUNT_SOL_DEFAULT, MAX_DEPLOY_AMOUNT_DEFAULT } from "./core/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const USER_CONFIG_PATH = path.resolve(__dirname, "..", "user-config.json");
const GMGN_CONFIG_PATH = path.resolve(__dirname, "..", "gmgn-config.json");

// Load migrated (or already-v2) config
const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)     process.env.RPC_URL            ??= u.rpcUrl;
if (u.walletKey)  process.env.WALLET_PRIVATE_KEY ??= u.walletKey;
if (u.llmModel)   process.env.LLM_MODEL          ??= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL       ??= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY        ??= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN  ??= String(u.dryRun);

// ─── Agent Meridian relay + HiveMind ────────────────────────────────────────
if (u.publicApiKey)          process.env.PUBLIC_API_KEY            ??= u.publicApiKey;
if (u.agentMeridianApiUrl)   process.env.AGENT_MERIDIAN_API_URL   ??= u.agentMeridianApiUrl;
if (u.hiveMindUrl)           process.env.HIVE_MIND_URL             ??= u.hiveMindUrl;
if (u.hiveMindApiKey)        process.env.HIVE_MIND_API_KEY        ??= u.hiveMindApiKey;
if (u.lpAgentRelayEnabled)   process.env.LPAGENT_RELAY_ENABLED    ??= String(u.lpAgentRelayEnabled);

// ─── GMGN ────────────────────────────────────────────────────────────────────
if (gmgnUserConfig.apiKey)  process.env.GMGN_API_KEY ??= gmgnUserConfig.apiKey;
if (u.gmgnApiKey)            process.env.GMGN_API_KEY ??= u.gmgnApiKey;

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
    maxPositionsPerToken: u.risk?.maxPositionsPerToken ?? 1,
    unrealizedLossMultiplier: u.risk?.unrealizedLossMultiplier ?? 2.0,  // halt if unrealized > multiplier × |dailyLossLimit|
  },

  // ─── Pool Screening Thresholds ─ v2 nested thresholds support ───────────
  // Supports both flat keys (v1) and nested thresholds object (v2):
  //   flat:    { "minFeeActiveTvlRatio": 0.05, "minTvl": 10000 }
  //   nested:  { "thresholds": { "minFeeActiveTvlRatio": 0.05, "minTvl": 10000 } }
  screening: {
    minFeeActiveTvlRatio: u.thresholds?.minFeeActiveTvlRatio ?? 0.05,
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
    // ─── Discord Signals (via Agent Meridian relay) ────────────────────────
    // ⚠️  HIGH RISK — Discord signals are community-sourced tokens, NOT vetted.
    //      Set useDiscordSignals: false to disable entirely.
    useDiscordSignals: u.thresholds?.useDiscordSignals ?? u.useDiscordSignals ?? false,
    discordSignalMode: u.thresholds?.discordSignalMode ?? u.discordSignalMode ?? "merge", // "merge" = add to normal pool; "only" = replace with Discord pools only
    // ─── Operational tunables ───────────────────────
    slippageBps:        u.screening?.slippageBps        ?? 300,
    screeningCooldownMs: u.screening?.screeningCooldownMs ?? 300_000,
    balanceCacheTtlMs:  u.screening?.balanceCacheTtlMs ?? 300_000,
    okxCacheTtlMs:      u.screening?.okxCacheTtlMs ?? 240_000,  // 4 min TTL for OKX enrichment cache
  },

  // ─── Chart Indicators ─────────────────────────────────────────────
  indicators: {
    enabled: u.indicators?.enabled ?? false,
    intervals: u.indicators?.intervals ?? ["5m"],
    entryPreset: u.indicators?.entryPreset ?? "rsi_reversal",
    exitPreset: u.indicators?.exitPreset ?? "bollinger_reversion",
    requireAllIntervals: u.indicators?.requireAllIntervals ?? false,
    rsiOversold: u.indicators?.rsiOversold ?? 35,
    rsiOverbought: u.indicators?.rsiOverbought ?? 65,
    bounceRules: {
      requireBullishSupertrend: u.indicators?.bounceRules?.requireBullishSupertrend ?? true,
      rejectAlreadyAtBottom:    u.indicators?.bounceRules?.rejectAlreadyAtBottom    ?? true,
      requireAboveSupertrend:    u.indicators?.bounceRules?.requireAboveSupertrend    ?? false,
      minRsi:                   u.indicators?.bounceRules?.minRsi                   ?? null,
      maxRsi:                   u.indicators?.bounceRules?.maxRsi                   ?? null,
      requireBbPosition:         u.indicators?.bounceRules?.requireBbPosition         ?? null,
    },
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.management?.minClaimAmount        ?? u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.management?.autoSwapAfterClaim    ?? u.autoSwapAfterClaim    ?? true,  // ✅ default true — swap claimed fees to SOL for compounding
    autoSwapAfterClose:    u.management?.autoSwapAfterClose    ?? u.autoSwapAfterClose    ?? true,
    outOfRangeBinsToClose: u.management?.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.management?.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.management?.minVolumeToRebalance  ?? u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.management?.stopLossPct           ?? u.stopLossPct           ?? -50,
    takeProfitFeePct:      u.management?.takeProfitFeePct      ?? u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.management?.minFeePerTvl24h       ?? u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.management?.minAgeBeforeYieldCheck ?? 60,
    minSolToOpen:          u.management?.minSolToOpen          ?? u.minSolToOpen          ?? 0.55,
    gasReserve:            u.management?.gasReserve            ?? u.gasReserve            ?? GAS_RESERVE_DEFAULT,
    baseDeployAmount:      u.management?.baseDeployAmount      ?? u.deployAmountSol   ?? BASE_DEPLOY_AMOUNT_DEFAULT,
    deployAmountSol:       u.management?.deployAmountSol       ?? u.deployAmountSol   ?? DEPLOY_AMOUNT_SOL_DEFAULT,
    maxDeployAmount:       u.management?.maxDeployAmount       ?? u.maxDeployAmount       ?? MAX_DEPLOY_AMOUNT_DEFAULT,
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
    // ─── Volatility-adaptive thresholds (overrides for high/low vol pools) ───
    // Example user-config.json overrides:
    //   "management": { "volatilityAdaptive": { "stopLossHighVol": -0.25 } }
    volatilityAdaptive: {
      stopLossHighVol:      u.management?.volatilityAdaptive?.stopLossHighVol      ?? -0.30,  // tight stop for high-volatility pools (vol ≥ 7)
      stopLossLowVol:       u.management?.volatilityAdaptive?.stopLossLowVol       ?? -0.20,  // loose stop for low-volatility pools (vol ≤ 2)
      stopLossWideRange:    u.management?.volatilityAdaptive?.stopLossWideRange    ?? -0.25,  // stop for wide-range positions (>50 bins)
      oorWaitHighVolMult:   u.management?.volatilityAdaptive?.oorWaitHighVolMult   ?? 0.50,   // multiply OOR wait by 0.5 when vol ≥ 7 (wait less — more volatile)
      oorWaitMedVolMult:    u.management?.volatilityAdaptive?.oorWaitMedVolMult    ?? 0.75,   // multiply OOR wait by 0.75 when 4 ≤ vol < 7
    },
  },

  // ─── OKX ────────────────────────────────
  okx: {
    okxApiTimeoutMs: u.okx?.okxApiTimeoutMs ?? 12_000,
  },

  // ─── Hive Mind ──────────────────────────────────────────────────────────────
  // HiveMind server URL (separate from Agent Meridian relay API URL).
  // HiveMind:   https://api.agentmeridian.xyz     (lesson/preset push/pull)
  // Relay API:  https://api.agentmeridian.xyz/api (positions, PnL, top-lp)
  hiveMind: {
    url:     u.hiveMind?.url || u.hive?.url || process.env.HIVE_MIND_URL || "https://api.agentmeridian.xyz",
    apiKey:  u.hiveMind?.apiKey || u.hive?.apiKey || process.env.HIVE_MIND_API_KEY || null,
    agentId: u.hiveMind?.agentId || u.hive?.agentId || null,
    pullMode: u.hiveMind?.pullMode || u.hive?.pullMode || "auto",
  },

  // ─── Agent Meridian API ─────────────────────────────────────────────────────
  // Agent Meridian relay API — handles positions, PnL, top-lp, study-top-lp,
  // Discord signal candidates, and OKX server-side enrichment.
  api: {
    url:          u.agentMeridianApiUrl || u.api?.url || process.env.AGENT_MERIDIAN_API_URL || "https://api.agentmeridian.xyz/api",
    publicApiKey: u.publicApiKey || u.api?.publicApiKey || process.env.PUBLIC_API_KEY || null,
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy?.strategy  ?? u.strategy  ?? "bid_ask",
    binsBelow: u.strategy?.binsBelow ?? 69,
    binsAbove: u.strategy?.binsAbove ?? 5,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.schedule?.managementIntervalMin  ?? (isDryRun() ? 1 : 10),
    screeningIntervalMin:   u.schedule?.screeningIntervalMin   ?? (isDryRun() ? 1 : 30),
    pnlPollIntervalSec:     u.schedule?.pnlPollIntervalSec     ?? 30,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.llm?.temperature ?? 0.373,
    maxTokens:   u.llm?.maxTokens   ?? u.maxTokens   ?? 4096,
    maxSteps:    u.llm?.maxSteps    ?? u.maxSteps    ?? 10,
    screenerMaxSteps: u.llm?.screenerMaxSteps ?? 5,
    managerMaxSteps:  u.llm?.managerMaxSteps  ?? u.managerMaxSteps  ?? 4,
    managementModel: u.llm?.models?.manager ?? u.llm?.managementModel ?? u.models?.manager ?? process.env.LLM_MODEL_MANAGER ?? process.env.LLM_MODEL ?? u.llmModel ?? "MiniMax-M2.1-Fast",  // MANAGER uses deterministic rules — can be cheaper/faster than SCREENER
    screeningModel:  u.llm?.models?.screener ?? u.llm?.screeningModel ?? u.models?.screener ?? u.screeningModel  ?? process.env.LLM_MODEL ?? u.llmModel ?? "MiniMax-M2.7",
    generalModel:    u.llm?.models?.general ?? u.llm?.generalModel ?? u.models?.general ?? u.generalModel    ?? process.env.LLM_MODEL ?? u.llmModel ?? "MiniMax-M2.7",
    evolveModel:     u.llm?.models?.evolve  ?? u.llm?.evolveModel ?? process.env.LLM_MODEL ?? u.llmModel ?? "MiniMax-M2.7",
  },


  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  SOL_MINT,
    USDC: USDC_MINT,
    USDT: USDT_MINT,
  },

  // ─── GMGN Integration ────────────────────────────────────────────────────────
  // 5-stage pipeline: rank → token info → holders/traders + Meteora pool → chart indicators → best pool
  gmgn: {
    // Auth — prefer gmgn-config.json apiKey, then user-config flat key, then env
    apiKey: (() => {
      const k = gmgnUserConfig?.apiKey || u.gmgnApiKey || process.env.GMGN_API_KEY;
      return typeof k === "string" && k.trim() ? k.trim() : null;
    })(),
    baseUrl: gmgnUserConfig?.baseUrl || u.gmgnBaseUrl || "https://openapi.gmgn.ai",
    interval:       gmgnUserConfig?.interval       ?? u.gmgnInterval       ?? "5m",
    orderBy:       gmgnUserConfig?.orderBy       ?? u.gmgnOrderBy       ?? "default",
    direction:     gmgnUserConfig?.direction     ?? u.gmgnDirection     ?? "desc",
    limit:         gmgnUserConfig?.limit         ?? u.gmgnLimit         ?? 100,
    enrichLimit:   gmgnUserConfig?.enrichLimit   ?? u.gmgnEnrichLimit   ?? 20,
    requestDelayMs: gmgnUserConfig?.requestDelayMs ?? u.gmgnRequestDelayMs ?? 350,
    maxRetries:    gmgnUserConfig?.maxRetries    ?? u.gmgnMaxRetries    ?? 2,
    holdersLimit:  gmgnUserConfig?.holdersLimit  ?? u.gmgnHoldersLimit  ?? 100,
    klineResolution: gmgnUserConfig?.klineResolution ?? u.gmgnKlineResolution ?? "5m",
    klineLookbackMinutes: gmgnUserConfig?.klineLookbackMinutes ?? u.gmgnKlineLookbackMinutes ?? 60,
    filters: Array.isArray(gmgnUserConfig?.filters) ? gmgnUserConfig.filters : (Array.isArray(u.gmgnFilters) ? u.gmgnFilters : ["renounced", "frozen", "not_wash_trading"]),
    platforms: Array.isArray(gmgnUserConfig?.platforms) ? gmgnUserConfig.platforms : (Array.isArray(u.gmgnPlatforms) ? u.gmgnPlatforms : ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    // ─── Thresholds ───────────────────────────
    minMcap:         gmgnUserConfig?.minMcap         ?? u.gmgnMinMcap         ?? u.minMcap         ?? 150_000,
    maxMcap:         gmgnUserConfig?.maxMcap         ?? u.gmgnMaxMcap         ?? u.maxMcap         ?? 10_000_000,
    minTvl:          gmgnUserConfig?.minTvl          ?? u.gmgnMinTvl          ?? u.minTvl          ?? 10_000,
    minVolume:       gmgnUserConfig?.minVolume       ?? u.gmgnMinVolume       ?? 1000,
    minHolders:     gmgnUserConfig?.minHolders     ?? u.gmgnMinHolders     ?? u.minHolders     ?? 500,
    minTokenAgeHours: gmgnUserConfig?.minTokenAgeHours ?? u.gmgnMinTokenAgeHours ?? 2,
    maxTokenAgeHours: gmgnUserConfig?.maxTokenAgeHours ?? u.gmgnMaxTokenAgeHours ?? 24 * 7,
    minSmartDegenCount: gmgnUserConfig?.minSmartDegenCount ?? u.gmgnMinSmartDegenCount ?? 1,
    requireKol:      gmgnUserConfig?.requireKol      ?? u.gmgnRequireKol      ?? true,
    minKolCount:     gmgnUserConfig?.minKolCount     ?? u.gmgnMinKolCount     ?? 1,
    maxRugRatio:    gmgnUserConfig?.maxRugRatio    ?? u.gmgnMaxRugRatio    ?? 0.3,
    maxTop10HolderRate: gmgnUserConfig?.maxTop10HolderRate ?? u.gmgnMaxTop10HolderRate ?? 0.5,
    maxBundlerRate: gmgnUserConfig?.maxBundlerRate ?? u.gmgnMaxBundlerRate ?? 0.5,
    maxRatTraderRate: gmgnUserConfig?.maxRatTraderRate ?? u.gmgnMaxRatTraderRate ?? 0.2,
    maxFreshWalletRate: gmgnUserConfig?.maxFreshWalletRate ?? u.gmgnMaxFreshWalletRate ?? 0.2,
    maxDevTeamHoldRate: gmgnUserConfig?.maxDevTeamHoldRate ?? u.gmgnMaxDevTeamHoldRate ?? 0.02,
    maxBotDegenRate: gmgnUserConfig?.maxBotDegenRate ?? u.gmgnMaxBotDegenRate ?? 0.4,
    maxSniperCount: gmgnUserConfig?.maxSniperCount ?? u.gmgnMaxSniperCount ?? 20,
    maxSniperHoldRate: gmgnUserConfig?.maxSniperHoldRate ?? u.gmgnMaxSniperHoldRate ?? 0.3,
    minTotalFeeSol: gmgnUserConfig?.minTotalFeeSol ?? u.gmgnMinTotalFeeSol ?? 30,
    athFilterPct:   gmgnUserConfig?.athFilterPct   ?? u.gmgnAthFilterPct   ?? null,
    // ─── KOL Matching ────────────────────────
    // Preferred KOLs: wallets you WANT following (holds your token, likely bullish)
    preferredKolMinHoldPct: gmgnUserConfig?.preferredKolMinHoldPct ?? u.gmgnPreferredKolMinHoldPct ?? 1,
    preferredKolNames: Array.isArray(gmgnUserConfig?.preferredKolNames) ? gmgnUserConfig.preferredKolNames : (Array.isArray(u.gmgnPreferredKolNames) ? u.gmgnPreferredKolNames : []),
    // Dump KOLs: wallets that have a history of selling after promotion (warning flag)
    dumpKolMinHoldPct: gmgnUserConfig?.dumpKolMinHoldPct ?? u.gmgnDumpKolMinHoldPct ?? 0.5,
    dumpKolNames: Array.isArray(gmgnUserConfig?.dumpKolNames) ? gmgnUserConfig.dumpKolNames : (Array.isArray(u.gmgnDumpKolNames) ? u.gmgnDumpKolNames : []),
    // ─── Chart Indicator Filter ──────────────
    indicatorFilter:    gmgnUserConfig?.indicatorFilter    ?? u.gmgnIndicatorFilter    ?? true,
    indicatorInterval:  gmgnUserConfig?.indicatorInterval ?? u.gmgnIndicatorInterval ?? "15_MINUTE",
    indicatorRules: (() => {
      const r = gmgnUserConfig?.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                  r.minRsi                  ?? null,
        maxRsi:                  r.maxRsi                  ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },
};

/**
 * Conviction Sizing Matrix — position sizing based on conviction level
 * and number of open positions. 3x sizing (very_high) only when 0 positions open.
 *
 * | Positions | Conviction | Amount    |
 * |-----------|------------|-----------|
 * | 0         | very_high  | 1.50 SOL  |
 * | 1+        | very_high  | 1.00 SOL  |
 * | any       | high       | 1.00 SOL  |
 * | any       | normal     | 0.50 SOL  |
 *
 * Amounts are clamped to wallet balance minus gasReserve.
 *
 * The matrix values are static defaults. At runtime, after enough closed positions
 * have been recorded, the sizing-evolver.js module evolves these multipliers based
 * on rolling win-rate stats per conviction level. computeDeployAmount reads from
 * the evolved matrix when available (falls back to these defaults otherwise).
 */
const DEFAULT_SIZING_MATRIX = {
  very_high: { 0: 1.50, 1: 1.00, other: 1.00 },
  high:      { 0: 1.00, 1: 1.00, other: 1.00 },
  normal:    { any: 0.50 },
};

export { DEFAULT_SIZING_MATRIX };

// Cached reference to the evolved matrix loader (avoids circular import at module scope)
let _getEffectiveMatrix = null;

export function registerSizingMatrixLoader(fn) {
  _getEffectiveMatrix = fn;
}

function getActiveMatrix() {
  if (_getEffectiveMatrix) {
    try {
      return _getEffectiveMatrix();
    } catch (_) {
      // not ready yet
    }
  }
  return DEFAULT_SIZING_MATRIX;
}

export function computeDeployAmount(walletSol, openPositions = 0, conviction = "normal") {
  const reserve  = config.management.gasReserve  ?? 0.2;
  const deployable = Math.max(0, walletSol - reserve);
  if (deployable <= 0) return { amount: 0, error: "Insufficient SOL after gas reserve" };

  const SIZING_MATRIX = getActiveMatrix();
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

/**
 * Fail-fast validation of required environment variables.
 * Throws a clear error if WALLET_PRIVATE_KEY or RPC_URL is missing.
 */
export function validateEnv() {
  if (!process.env.WALLET_PRIVATE_KEY?.trim()) {
    throw new Error("Missing required env var: WALLET_PRIVATE_KEY — set it in .env or user-config.json");
  }
  if (!process.env.RPC_URL?.trim()) {
    throw new Error("Missing required env var: RPC_URL — set it in .env or user-config.json");
  }
}

// Validate on module load (fail-fast at startup)
validateEnv();
