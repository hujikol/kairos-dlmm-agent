/**
 * Config validation and coercion for update_config.
 * Ensures values are the correct type and within valid ranges before applying.
 */

const SCHEMA = {
  // ─── Screening ────────────────────────────
  minFeeActiveTvlRatio:  { type: "number", min: 0,    max: 1,       coerce: true },
  minTvl:                { type: "number", min: 0,                 coerce: true },
  maxTvl:                { type: "number", min: 0,                 coerce: true },
  minVolume:             { type: "number", min: 0,                 coerce: true },
  minOrganic:            { type: "number", min: 0,    max: 100,     coerce: true },
  minHolders:            { type: "number", min: 0,                 coerce: true },
  minMcap:               { type: "number", min: 0,                 coerce: true },
  maxMcap:               { type: "number", min: 0,                 coerce: true },
  minBinStep:            { type: "number", min: 1,                 coerce: true },
  maxBinStep:            { type: "number", min: 1,                 coerce: true },
  timeframe:             { type: "enum",   values: ["1m", "5m", "15m", "1h", "4h", "1d"] },
  category:              { type: "string" },
  minTokenFeesSol:       { type: "number", min: 0,                 coerce: true },
  maxBundlePct:          { type: "number", min: 0,    max: 100,     coerce: true },
  maxBotHoldersPct:      { type: "number", min: 0,    max: 100,     coerce: true },
  maxTop10Pct:           { type: "number", min: 0,    max: 100,     coerce: true },
  minTokenAgeHours:      { type: "number", min: 0,                 coerce: true, nullable: true },
  maxTokenAgeHours:      { type: "number", min: 0,                 coerce: true, nullable: true },
  athFilterPct:          { type: "number", min: -100, max: 0,      coerce: true, nullable: true },
  // ─── Management ────────────────────────────
  minClaimAmount:        { type: "number", min: 0,                 coerce: true },
  autoSwapAfterClaim:    { type: "boolean" },
  autoSwapAfterClose:    { type: "boolean" },
  outOfRangeBinsToClose: { type: "number", min: 0,                 coerce: true },
  outOfRangeWaitMinutes: { type: "number", min: 1,                 coerce: true },
  minVolumeToRebalance:  { type: "number", min: 0,                 coerce: true },
  stopLossPct:           { type: "number", min: -100, max: 0,      coerce: true },
  takeProfitFeePct:      { type: "number", min: 0,                 coerce: true },
  trailingTakeProfit:    { type: "boolean" },
  trailingTriggerPct:    { type: "number", min: 0,                 coerce: true },
  trailingDropPct:       { type: "number", min: 0,                 coerce: true },
  solMode:               { type: "boolean" },
  minSolToOpen:          { type: "number", min: 0,                 coerce: true },
  baseDeployAmount:      { type: "number", min: 0.01,              coerce: true },
  gasReserve:            { type: "number", min: 0,                 coerce: true },
  maxDeployAmount:       { type: "number", min: 0.01,              coerce: true },
  minFeePerTvl24h:       { type: "number", min: 0,                 coerce: true },
  lossStreakEnabled:     { type: "boolean" },
  lossStreakThreshold:   { type: "number", min: 1,                 coerce: true },
  lossStreakMinPnlPct:   { type: "number", max: 0,                 coerce: true },
  lossStreakMinPositionAgeCycles: { type: "number", min: 0,        coerce: true },
  // ─── Risk ─────────────────────────────────
  maxPositions:          { type: "number", min: 1,    max: 20,      coerce: true },
  dailyProfitTarget:     { type: "number", min: 0,                 coerce: true },
  dailyLossLimit:        { type: "number", max: 0,                 coerce: true },
  maxPositionsPerToken:   { type: "number", min: 1,    max: 10,     coerce: true },
  // ─── Schedule ──────────────────────────────
  managementIntervalMin:   { type: "number", min: 1,    max: 1440,    coerce: true },
  screeningIntervalMin:  { type: "number", min: 1,    max: 1440,    coerce: true },
  // ─── LLM ─────────────────────────────────
  managementModel:        { type: "string", nullable: true },
  screeningModel:        { type: "string", nullable: true },
  generalModel:          { type: "string", nullable: true },
  // ─── Strategy ────────────────────────────
  binsBelow:              { type: "number", min: 1,                 coerce: true },
  // ─── Behavior ─────────────────────────────
  cavemanEnabled:         { type: "boolean" },
};

const _CONFIG_MAP = {
  minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
  minTvl: ["screening", "minTvl"],
  maxTvl: ["screening", "maxTvl"],
  minVolume: ["screening", "minVolume"],
  minOrganic: ["screening", "minOrganic"],
  minHolders: ["screening", "minHolders"],
  minMcap: ["screening", "minMcap"],
  maxMcap: ["screening", "maxMcap"],
  minBinStep: ["screening", "minBinStep"],
  maxBinStep: ["screening", "maxBinStep"],
  timeframe: ["screening", "timeframe"],
  category: ["screening", "category"],
  minTokenFeesSol: ["screening", "minTokenFeesSol"],
  maxBundlePct: ["screening", "maxBundlePct"],
  maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
  maxTop10Pct: ["screening", "maxTop10Pct"],
  minTokenAgeHours: ["screening", "minTokenAgeHours"],
  maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
  athFilterPct: ["screening", "athFilterPct"],
  minFeePerTvl24h: ["management", "minFeePerTvl24h"],
  minClaimAmount: ["management", "minClaimAmount"],
  autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
  autoSwapAfterClose: ["management", "autoSwapAfterClose"],
  outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
  outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
  minVolumeToRebalance: ["management", "minVolumeToRebalance"],
  stopLossPct: ["management", "stopLossPct"],
  takeProfitFeePct: ["management", "takeProfitFeePct"],
  trailingTakeProfit: ["management", "trailingTakeProfit"],
  trailingTriggerPct: ["management", "trailingTriggerPct"],
  trailingDropPct: ["management", "trailingDropPct"],
  solMode: ["management", "solMode"],
  minSolToOpen: ["management", "minSolToOpen"],
  baseDeployAmount: ["management", "baseDeployAmount"],
  gasReserve: ["management", "gasReserve"],
  maxDeployAmount: ["management", "maxDeployAmount"],
  lossStreakEnabled: ["management", "lossStreakEnabled"],
  lossStreakThreshold: ["management", "lossStreakThreshold"],
  lossStreakMinPnlPct: ["management", "lossStreakMinPnlPct"],
  lossStreakMinPositionAgeCycles: ["management", "lossStreakMinPositionAgeCycles"],
  maxPositions: ["risk", "maxPositions"],
  managementIntervalMin: ["schedule", "managementIntervalMin"],
  screeningIntervalMin: ["schedule", "screeningIntervalMin"],
  managementModel: ["llm", "managementModel"],
  screeningModel: ["llm", "screeningModel"],
  generalModel: ["llm", "generalModel"],
  binsBelow: ["strategy", "binsBelow"],
  binsAbove: ["strategy", "binsAbove"],
  cavemanEnabled: ["cavemanEnabled", null],
};

/**
 * Coerce a raw value to the correct type per schema.
 * @param {string} key - config field name
 * @param {any} val - raw value from JSON/LLM
 * @returns {any} - coerced value, or null if invalid
 */
function coerce(key, val) {
  const schema = SCHEMA[key];
  if (!schema) return val; // passthrough

  // Null / undefined → nullable fields stay null
  if (val == null) {
    return schema.nullable ? null : val;
  }

  // Empty string → nullable fields become null, non-nullable become unchanged
  if (val === "") {
    return schema.nullable ? null : val;
  }

  if (schema.type === "boolean") {
    if (typeof val === "boolean") return val;
    if (val === "true" || val === "1") return true;
    if (val === "false" || val === "0") return false;
    return Boolean(val);
  }

  if (schema.type === "number") {
    const n = Number(val);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  if (schema.type === "enum") {
    return schema.values.includes(val) ? val : null;
  }

  return val; // string — passthrough
}

/**
 * Validate + coerce a map of changes.
 * Returns { valid: { key: coercedValue }, invalid: [{ key, val, reason }] }
 */
export function validateAndCoerce(changes) {
  const valid = {};
  const invalid = [];

  for (const [key, rawVal] of Object.entries(changes)) {
    const schema = SCHEMA[key];
    if (!schema) {
      invalid.push({ key, val: rawVal, reason: "unknown field" });
      continue;
    }

    let val = rawVal;

    // String coercion for known numeric/boolean fields
    if (schema.coerce || schema.type === "number" || schema.type === "boolean") {
      val = coerce(key, rawVal);
    }

    if (val === null && !schema.nullable) {
      invalid.push({ key, val: rawVal, reason: `null not allowed for ${key}` });
      continue;
    }

    if (val !== null && val !== undefined) {
      if (schema.type === "number") {
        if (schema.min != null && val < schema.min) {
          invalid.push({ key, val: rawVal, reason: `${val} below min ${schema.min}` });
          continue;
        }
        if (schema.max != null && val > schema.max) {
          invalid.push({ key, val: rawVal, reason: `${val} above max ${schema.max}` });
          continue;
        }
      }
      if (schema.type === "enum") {
        if (!schema.values.includes(val)) {
          invalid.push({ key, val: rawVal, reason: `${val} not in [${schema.values.join(", ")}]` });
          continue;
        }
      }
    }

    valid[key] = val;
  }

  return { valid, invalid };
}

