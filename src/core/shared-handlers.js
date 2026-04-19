// Shared handlers — extracted business logic for duplicated commands.
// Each function returns raw data; formatting is applied by the caller
// (REPL uses console.log, Telegram uses HTML).

import { getWalletBalances } from "../integrations/helius.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getTopCandidates } from "../screening/discovery.js";
import { config } from "../config.js";
import { getPerformanceSummary } from "./lessons.js";
import { generateBriefing } from "../notifications/briefing.js";
import { runScreeningCycle } from "./cycles.js";
import { swapAllTokensToSol } from "../integrations/helius.js";

// ─── /status ───────────────────────────────────────────────────────────────────
export async function getStatusData() {
  const [wallet, positionsData] = await Promise.all([
    getWalletBalances(),
    getMyPositions({ force: true }),
  ]);
  return {
    wallet,           // { sol, sol_usd, sol_price, tokens, total_usd }
    positions: positionsData.positions,
    total_positions: positionsData.total_positions,
  };
}

// ─── /balance ─────────────────────────────────────────────────────────────────
export async function getBalanceData() {
  const wallet = await getWalletBalances();
  return {
    sol: wallet.sol,
    sol_usd: wallet.sol_usd,
    tokens: wallet.tokens,
    total_usd: wallet.total_usd,
  };
}

// ─── /candidates ───────────────────────────────────────────────────────────────
export async function getCandidatesData({ limit = 5 } = {}) {
  const result = await getTopCandidates({ limit });
  return {
    candidates: result.candidates,
    total_eligible: result.total_eligible,
    total_screened: result.total_screened,
  };
}

// ─── /thresholds ───────────────────────────────────────────────────────────────
export function getThresholdsData() {
  const s = config.screening;
  const m = config.management;
  const perf = getPerformanceSummary();
  return {
    screening: {
      minFeeActiveTvlRatio: s.minFeeActiveTvlRatio,
      minOrganic: s.minOrganic,
      minHolders: s.minHolders,
      minTvl: s.minTvl,
      maxTvl: s.maxTvl,
      minVolume: s.minVolume,
      minTokenFeesSol: s.minTokenFeesSol,
      maxBundlePct: s.maxBundlePct,
      maxBotHoldersPct: s.maxBotHoldersPct,
      maxTop10Pct: s.maxTop10Pct,
      timeframe: s.timeframe,
    },
    management: {
      deployAmountSol: m.deployAmountSol,
      maxPositions: m.maxPositions,
      minSolToOpen: m.minSolToOpen,
      gasReserve: m.gasReserve,
      strategy: m.strategy,
      stopLossPct: m.stopLossPct,
      takeProfitFeePct: m.takeProfitFeePct,
      trailingTakeProfit: m.trailingTakeProfit,
      trailingTriggerPct: m.trailingTriggerPct,
      trailingDropPct: m.trailingDropPct,
      outOfRangeWaitMinutes: m.outOfRangeWaitMinutes,
    },
    performance: perf,   // { total_positions_closed, win_rate_pct, avg_pnl_pct } or null
  };
}

// ─── /briefing ─────────────────────────────────────────────────────────────────
export async function getBriefingData() {
  return generateBriefing();
}

// ─── /screen ───────────────────────────────────────────────────────────────────
export function triggerScreen() {
  runScreeningCycle().catch(() => {});  // fire-and-forget
  return { triggered: true };
}

// ─── /swap-all ─────────────────────────────────────────────────────────────────
export async function getSwapAllResult() {
  return swapAllTokensToSol();
}

// ─── /positions (for Telegram) ─────────────────────────────────────────────────
export async function getPositionsData() {
  const { positions, total_positions } = await getMyPositions({ force: true });
  return { positions, total_positions };
}