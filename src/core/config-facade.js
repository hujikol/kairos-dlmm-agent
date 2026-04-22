/**
 * src/core/config-facade.js
 *
 * Typed config facade — provides frozen, validated getter functions for each
 * config section. All importers should migrate from direct `config.something`
 * access to these getters over time. The old `config` object remains working
 * for backward compatibility.
 *
 * Each getter returns a plain frozen object. No Proxy, no lazy validation
 * coupling — callers get a clean snapshot on each call.
 *
 * Note: when config is accessed at module scope, validation is triggered lazily
 * via the Proxy in config.js on first property access. All getter functions
 * are safe to call at any time — they read from the already-validated Proxy.
 */

import { config } from "../../config.js";

// ─── Section getters ─────────────────────────────────────────────────────────

/**
 * Pool screening thresholds and operational tunables.
 * Maps to `config.screening` (v2 nested) or flat keys (v1).
 */
export function getScreeningConfig() {
  const s = config.screening;
  return Object.freeze({
    // Thresholds
    minFeeActiveTvlRatio: s.minFeeActiveTvlRatio ?? 0.05,
    minTvl:               s.minTvl               ?? 10_000,
    maxTvl:               s.maxTvl               ?? 150_000,
    minVolume:            s.minVolume            ?? 500,
    minOrganic:           s.minOrganic           ?? 60,
    minHolders:           s.minHolders           ?? 500,
    minMcap:              s.minMcap              ?? 150_000,
    maxMcap:              s.maxMcap              ?? 10_000_000,
    minBinStep:           s.minBinStep           ?? 80,
    maxBinStep:           s.maxBinStep           ?? 125,
    timeframe:            s.timeframe            ?? "5m",
    category:             s.category             ?? "trending",
    minTokenFeesSol:      s.minTokenFeesSol      ?? 30,
    maxBundlePct:         s.maxBundlePct         ?? 30,
    maxBotHoldersPct:     s.maxBotHoldersPct     ?? 30,
    maxTop10Pct:          s.maxTop10Pct          ?? 60,
    blockedLaunchpads:    s.blockedLaunchpads    ?? [],
    minTokenAgeHours:     s.minTokenAgeHours     ?? null,
    maxTokenAgeHours:     s.maxTokenAgeHours     ?? null,
    athFilterPct:         s.athFilterPct         ?? null,
    // Operational tunables
    slippageBps:          s.slippageBps           ?? 300,
    screeningCooldownMs:  s.screeningCooldownMs  ?? 300_000,
    balanceCacheTtlMs:   s.balanceCacheTtlMs    ?? 300_000,
  });
}

/**
 * Position management settings.
 * Maps to `config.management`.
 */
export function getManagementConfig() {
  const m = config.management;
  return Object.freeze({
    minClaimAmount:              m.minClaimAmount              ?? 5,
    autoSwapAfterClaim:          m.autoSwapAfterClaim          ?? false,
    autoSwapAfterClose:          m.autoSwapAfterClose          ?? true,
    outOfRangeBinsToClose:       m.outOfRangeBinsToClose       ?? 10,
    outOfRangeWaitMinutes:      m.outOfRangeWaitMinutes       ?? 30,
    minVolumeToRebalance:        m.minVolumeToRebalance        ?? 1000,
    stopLossPct:                 m.stopLossPct                 ?? -50,
    takeProfitFeePct:            m.takeProfitFeePct            ?? 5,
    minFeePerTvl24h:             m.minFeePerTvl24h             ?? 7,
    minAgeBeforeYieldCheck:      m.minAgeBeforeYieldCheck       ?? 60,
    minSolToOpen:                m.minSolToOpen                ?? 0.55,
    gasReserve:                  m.gasReserve                  ?? 0.2,
    baseDeployAmount:            m.baseDeployAmount            ?? 0.35,
    deployAmountSol:             m.deployAmountSol             ?? 0.35,
    maxDeployAmount:             m.maxDeployAmount             ?? 50,
    trailingTakeProfit:         m.trailingTakeProfit          ?? true,
    trailingTriggerPct:         m.trailingTriggerPct          ?? 3,
    trailingDropPct:             m.trailingDropPct             ?? 1.5,
    solMode:                     m.solMode                     ?? false,
    pnlSuspectThresholdPct:       m.pnlSuspectThresholdPct     ?? 100,
    pnlSuspectMinUsd:            m.pnlSuspectMinUsd            ?? 1,
    yieldCheckMinAgeMs:          m.yieldCheckMinAgeMs          ?? 86_400_000,
    minLlmOutputLen:             m.minLlmOutputLen             ?? 5,
    maxLlmOutputDisplay:        m.maxLlmOutputDisplay         ?? 2000,
    telegramMaxMsgLen:           m.telegramMaxMsgLen           ?? 4096,
    lossStreakEnabled:           m.lossStreakEnabled           ?? false,
    lossStreakThreshold:         m.lossStreakThreshold         ?? 3,
    lossStreakMinPnlPct:         m.lossStreakMinPnlPct         ?? -1.0,
    lossStreakMinPositionAgeCycles: m.lossStreakMinPositionAgeCycles ?? 2,
  });
}

/**
 * Risk limits.
 * Maps to `config.risk`.
 */
export function getRiskConfig() {
  const r = config.risk;
  return Object.freeze({
    maxPositions:         r.maxPositions         ?? 3,
    dailyProfitTarget:    r.dailyProfitTarget    ?? 2,
    dailyLossLimit:       r.dailyLossLimit       ?? -5,
    maxPositionsPerToken: r.maxPositionsPerToken ?? 1,
  });
}

/**
 * LLM settings (per-role models, token limits, temperature).
 * Maps to `config.llm`.
 */
export function getLlmConfig() {
  const l = config.llm;
  return Object.freeze({
    temperature:      l.temperature      ?? 0.373,
    maxTokens:        l.maxTokens        ?? 4096,
    maxSteps:         l.maxSteps         ?? 10,
    screenerMaxSteps: l.screenerMaxSteps ?? 5,
    managerMaxSteps: l.managerMaxSteps ?? 4,
    managementModel: l.managementModel ?? "minimax/minimax-01",
    screeningModel:   l.screeningModel   ?? "minimax/minimax-01",
    generalModel:     l.generalModel     ?? "minimax/minimax-01",
    evolveModel:      l.evolveModel      ?? "minimax/minimax-01",
  });
}

/**
 * Strategy mapping (default strategy, bin widths).
 * Maps to `config.strategy`.
 */
export function getStrategyConfig() {
  const s = config.strategy;
  return Object.freeze({
    strategy:  s.strategy  ?? "bid_ask",
    binsBelow: s.binsBelow ?? 69,
    binsAbove: s.binsAbove ?? 5,
  });
}

/**
 * Scheduling intervals.
 * Maps to `config.schedule`.
 */
export function getScheduleConfig() {
  const s = config.schedule;
  return Object.freeze({
    managementIntervalMin: s.managementIntervalMin ?? 10,
    screeningIntervalMin:  s.screeningIntervalMin  ?? 30,
    pnlPollIntervalSec:     s.pnlPollIntervalSec     ?? 30,
  });
}

/**
 * OKX API settings.
 * Maps to `config.okx`.
 */
export function getOkxConfig() {
  const o = config.okx;
  return Object.freeze({
    okxApiTimeoutMs: o.okxApiTimeoutMs ?? 12_000,
  });
}

/**
 * Hive Mind settings.
 * Maps to `config.hiveMind`.
 */
export function getHiveMindConfig() {
  const h = config.hiveMind;
  return Object.freeze({
    url:      h.url      ?? null,
    apiKey:   h.apiKey   ?? null,
    agentId:  h.agentId  ?? null,
    pullMode: h.pullMode ?? "auto",
  });
}

/**
 * Agent Meridian API settings.
 * Maps to `config.api`.
 */
export function getApiConfig() {
  const a = config.api;
  return Object.freeze({
    url:          a.url          ?? "https://api.agentmeridian.xyz/api",
    publicApiKey: a.publicApiKey ?? null,
  });
}

/**
 * Convenience — returns a frozen snapshot of the full effective screening
 * config merged with flat-key fallbacks (v1 backward compat). This is the same
 * merge that `config.screening` already does via its Proxy, but expressed as
 * a plain frozen object for callers that prefer deterministic snapshots.
 */
export function getFullScreeningSnapshot() {
  return getScreeningConfig(); // already frozen
}
