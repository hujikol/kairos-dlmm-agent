import fs from "fs";
import writeFileAtomic from "write-file-atomic";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
import { studyTopLPers } from "../integrations/lpagent.js";
import { validateAndCoerce } from "../core/config-validator.js";
import {
  addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword,
  getPerformanceHistory, pinLesson, unpinLesson, listLessons,
} from "../core/lessons.js";
import {
  addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy,
} from "../core/strategy-library.js";
import { config, USER_CONFIG_PATH } from "../config.js";
import { log, logAction } from "../core/logger.js";
import { runManagementCycle } from "../core/cycles.js";

let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

const CONFIG_MAP = {
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
  maxBundlePct:     ["screening", "maxBundlePct"],
  maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
  maxTop10Pct: ["screening", "maxTop10Pct"],
  minTokenAgeHours: ["screening", "minTokenAgeHours"],
  maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
  athFilterPct:     ["screening", "athFilterPct"],
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
  cavemanEnabled: ["cavemanEnabled", null], // root-level key — special-cased below
};

export function registerAdmin(registerTool) {
  registerTool("run_management_cycle", async () => {
    try {
      const report = await runManagementCycle({ silent: false });
      return { success: true, report: report || "No action taken" };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  registerTool("self_update", async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  registerTool("get_performance_history", getPerformanceHistory);

  registerTool("add_strategy", addStrategy);
  registerTool("list_strategies", listStrategies);
  registerTool("get_strategy", getStrategy);
  registerTool("set_active_strategy", setActiveStrategy);
  registerTool("remove_strategy", removeStrategy);

  registerTool("get_top_lpers", studyTopLPers);
  registerTool("study_top_lpers", studyTopLPers);

  registerTool("add_lesson", ({ rule, tags, pinned, role }) => {
    let parsedTags = tags;
    if (typeof parsedTags === "string") {
      try { parsedTags = JSON.parse(parsedTags); } catch (e) { parsedTags = [parsedTags]; }
    }
    if (!Array.isArray(parsedTags)) parsedTags = [];
    addLesson(rule, parsedTags, { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  });

  registerTool("pin_lesson",   ({ id }) => pinLesson(id));
  registerTool("unpin_lesson", ({ id }) => unpinLesson(id));
  registerTool("list_lessons", ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }));
  registerTool("clear_lessons", ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("info", "lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("info", "lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("info", "lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  });

  registerTool("update_config", ({ changes, reason = "" }) => {
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    const { valid, invalid } = validateAndCoerce(changes);

    if (invalid.length > 0) {
      log("info", "config", `update_config rejected: ${JSON.stringify(invalid)}`);
      return { success: false, invalid, reason };
    }

    const applied = {};
    const beforeMap = {};
    const unknown = [];

    for (const [key, val] of Object.entries(valid)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("info", "config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      if (section === "cavemanEnabled") {
        // Root-level key — no section prefix
        const before = config[section];
        beforeMap[key] = before;
        config[section] = val;
        log("info", "config", `update_config: config.${section} ${before} → ${val}`);
        continue;
      }
      const before = config[section][field];
      beforeMap[key] = before;
      config[section][field] = val;
      log("info", "config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    writeFileAtomic.sync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("info", "config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}: ${beforeMap[k]} → ${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("info", "config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  });
}
