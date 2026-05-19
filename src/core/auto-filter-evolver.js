import { getDB } from "./db.js";
import { config as globalConfig, USER_CONFIG_PATH, reloadScreeningThresholds } from "../config.js";
import { log } from "./logger.js";
import crypto from "crypto";
import fs from "fs";

const EVOLVE_MIN_POSITIONS = 5;
const SANITY_BAND = 0.30;
const SIGNAL_COLUMNS = ["organic_score", "fee_tvl_ratio", "volatility", "bin_step"];

export function loadUserConfig() {
  return globalConfig;
}

export function analyzeFilterPerformance() {
  const db = getDB();
  const positions = db.prepare(`
    SELECT position, pnl_pct, organic_score, fee_tvl_ratio, volatility, bin_step
    FROM performance
    WHERE pnl_pct IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT 100
  `).all();

  if (positions.length < EVOLVE_MIN_POSITIONS) {
    log("debug", "evolver", `${positions.length} < ${EVOLVE_MIN_POSITIONS} — skipping`);
    return null;
  }

  const medianPnl = [...positions].sort((a, b) => a.pnl_pct - b.pnl_pct)[Math.floor(positions.length / 2)].pnl_pct;
  const winners = positions.filter(p => p.pnl_pct > medianPnl);
  const losers  = positions.filter(p => p.pnl_pct < medianPnl);

  if (winners.length < 2 || losers.length < 2) return null;

  const cfg = loadUserConfig();
  const changes = [];

  for (const col of SIGNAL_COLUMNS) {
    const current = cfg.screening?.[col];
    if (current == null) continue;

    const winnerVals = winners.map(p => p[col]).filter(v => v != null);
    const loserVals  = losers.map(p => p[col]).filter(v => v != null);
    if (winnerVals.length === 0 || loserVals.length === 0) continue;

    const winnerAvg = winnerVals.reduce((s, v) => s + v, 0) / winnerVals.length;
    const loserAvg  = loserVals.reduce((s, v) => s + v, 0) / loserVals.length;

    let proposed;
    if ((col === "organic_score" || col === "fee_tvl_ratio") && loserAvg < winnerAvg * 0.8) {
      const target = winnerAvg * 0.9;
      const minVal = current * (1 - SANITY_BAND);
      const maxVal = current * (1 + SANITY_BAND);
      proposed = Math.max(minVal, Math.min(maxVal, target));
    } else {
      continue;
    }

    if (Math.abs(proposed - current) < current * 0.05) continue;
    const rounded = current < 1 ? Number(proposed.toFixed(4)) : Math.round(proposed);
    changes.push({ filter: col, current, proposed: rounded, winnerAvg, loserAvg });
  }

  if (changes.length === 0) return null;

  if (!cfg.screening) cfg.screening = {};
  for (const { filter, proposed } of changes) {
    cfg.screening[filter] = proposed;
  }
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  reloadScreeningThresholds();

  db.prepare(`
    INSERT INTO lessons (id, rule, tags, outcome, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    `[AUTO-EVOLVED] ${changes.map(c => `${c.filter}: ${c.current} → ${c.proposed}`).join(", ")}`,
    JSON.stringify(["evolution", "filter_evolution"]),
    "filter_evolution",
    new Date().toISOString()
  );

  log("info", "evolver", `Auto-evolved ${changes.length} filter params: ${changes.map(c => `${c.filter}: ${c.current}→${c.proposed}`).join(", ")}`);
  return changes;
}