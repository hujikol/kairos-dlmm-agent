import { getPaperPoolMemory } from "./paper-wallet.js";
/** Screening decisions depend only on measured inputs and persisted numeric rules. */
import { log } from "./logger.js";
import { getMyPositions, getActiveBin } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { getTopCandidates, getPoolDetail } from "../screening/discovery.js";
import { config, computeDeployAmount, isDryRun } from "../config.js";
import { _busyState, _timersState, timers } from "./state/scheduler-state.js";
import { checkDailyCircuitBreaker } from "./daily-tracker.js";
import { fetchAndReconCandidates, applyHardFilters } from "./screening-helpers.js";
import { simulatePoolDeploy } from "./simulator.js";
import { isToxicPool } from "./toxic-pool-filter.js";
import { getPoolMemory, isPoolOnCooldown } from "../features/pool-memory.js";
import { defaultGateway } from "./agent-gateway.js";
import { entryGate, volumeGate } from "./decision-rules.js";
import { getActiveRules } from "./rule-memory.js";
import { recordDecision } from "./decision-log.js";
import { startCycleOutcome, updateCycleOutcome, finalizeCycleOutcome, recordDeployConfirmed } from "./cycle-outcome.js";
import { isEnabled, sendHTML, drainTelegramQueue } from "../notifications/telegram.js";
import { escapeHTMLLocal } from "./cycle-helpers.js";
import { getDB } from "./db.js";

export async function runScreeningCycle({ silent = false, gateway = defaultGateway, poolAddress = null } = {}) {
  if (_busyState._screeningBusy) return null;
  _busyState._screeningBusy = true;
  _timersState.screeningLastTriggered = Date.now();
  let cycleId;
  let report = null;
  try {
    cycleId = startCycleOutcome("screening");
    timers.screeningLastRun = Date.now();
    const [positions, balance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (!Array.isArray(positions?.positions) || !Number.isInteger(positions.total_positions) || positions.total_positions < 0 ||
        !Number.isFinite(balance?.sol) || balance.sol < 0) throw new Error("Incomplete portfolio data");
    if (Math.max(positions.total_positions, positions.positions.length) >= config.risk.maxPositions) return null;
    const sizing = computeDeployAmount(balance.sol, positions.total_positions, "normal");
    if (sizing.error || sizing.amount <= 0) return null;
    const circuit = await checkDailyCircuitBreaker({ positions: positions.positions });
    if (!["trade", "normal"].includes(circuit.action)) return null;
    // The simulator expects USD per SOL, not the total wallet USD value.
    if (!Number.isFinite(balance.sol_price) || balance.sol_price <= 0) throw new Error("Missing SOL price");
    const found = await getTopCandidates({ limit: 10 });
    const discovered = (found?.candidates || found?.pools || []).slice(0, 10);
    const recon = await fetchAndReconCandidates(discovered);
    const passing = applyHardFilters(recon, config, positions).filter(({ pool }) =>
      (!poolAddress || pool.pool === poolAddress) && !isToxicPool(pool.pool) && !isPoolOnCooldown(pool.pool) &&
      !positions.positions.some(p => p.pool === pool.pool));
    const rules = getActiveRules();
    const candidates = await Promise.all(passing.map(async candidate => {
      const [bin, daily] = await Promise.all([
        getActiveBin({ pool_address: candidate.pool.pool }).catch(() => null),
        getPoolDetail({ pool_address: candidate.pool.pool, timeframe: "24h" }).catch(() => null),
      ]);
      return { ...candidate, pool: { ...candidate.pool, volume_24h: daily?.pool_address === candidate.pool.pool ? daily.volume : undefined,
        daily_fee_tvl_ratio: daily?.pool_address === candidate.pool.pool && Number.isFinite(daily.fee) && daily.active_tvl > 0 ? daily.fee / daily.active_tvl * 100 : undefined }, activeBin: bin?.binId,
        simulation: simulatePoolDeploy({ ...candidate.pool, volume_24h: daily?.pool_address === candidate.pool.pool ? daily.volume : undefined }, sizing.amount, balance.sol_price),
        memory: isDryRun() ? getPaperPoolMemory(candidate.pool.pool) : getPoolMemory({ pool_address: candidate.pool.pool }) };
    }));
    updateCycleOutcome(cycleId, { candidates_seen: recon.length, filters_passed: candidates.filter(c => !entryGate(c, rules)).length, llm_calls: 0 });
    const eligible = candidates.filter(c => !volumeGate(c, config.screening));
    const attempts = [];
    const excludedMints = new Set(positions.positions.map(p => p.base_mint));
    let remainingSol = balance.sol;
    const slots = config.risk.maxPositions - Math.max(positions.total_positions, positions.positions.length);
    for (let slot = 0; slot < slots; slot++) {
      const available = eligible.filter(c => !excludedMints.has(c.pool.base?.mint));
      if (!available.length) break;
      const nextSizing = computeDeployAmount(remainingSol, positions.total_positions + slot, "normal");
      if (nextSizing.error || nextSizing.amount <= 0) break;
      const attempt = await gateway.runScreeningCycle({ candidates: available, deployAmount: nextSizing.amount, solPrice: balance.sol_price, canDeploy: true, rules });
      attempts.push(attempt);
      if (!attempt.selected) break;
      excludedMints.add(attempt.selected.pool.base.mint);
      if (attempt.result?.success !== true || attempt.result?.blocked || attempt.result?.error) break;
      remainingSol -= nextSizing.amount;
      await recordDecision({ type: "deploy_attempt", pool: attempt.selected.pool.pool,
        position: attempt.result?.position, amount: nextSizing.amount, reasoning: attempt.content,
        metadata: { initiated_by: "rule", rules, simulation: attempt.selected.simulation } });
      if (!attempt.result.dry_run && attempt.result.position) {
        const after = await getMyPositions({ force: true });
        if (after.positions?.some(p => p.position === attempt.result.position && !p.closed)) recordDeployConfirmed(cycleId, attempt.result.position);
        else { attempt.content += " | Position not confirmed; stopping further deploys."; break; }
      }
    }
    report = attempts.map(a => a.content).join("\n") || "NO DEPLOY: volume or risk gate failed.";
    updateCycleOutcome(cycleId, { deploy_attempted: attempts.some(a => a.selected) ? 1 : 0 });
    const selectedPools = new Set(attempts.filter(a => a.selected).map(a => a.selected.pool.pool));
    const db = getDB();
    for (const c of candidates) db.prepare(`INSERT INTO rejected_candidates
      (cycle_outcome_id, pool_address, rejection_reason, rejected_at)
      VALUES (?, ?, ?, ?)`).run(cycleId, c.pool.pool,
        entryGate(c, rules) || volumeGate(c, config.screening) || (selectedPools.has(c.pool.pool) ? "selected_by_rules" : "ranked_lower"), new Date().toISOString());
    if (!selectedPools.size) await recordDecision({ type: "skip", reasoning: report, metadata: { initiated_by: "rule", rules } });
  } catch (e) {
    report = `Screening failed: ${e?.message ?? String(e)}`;
    log("error", "screening", report);
  } finally {
    _busyState._screeningBusy = false;
    if (cycleId != null) finalizeCycleOutcome(cycleId);
    drainTelegramQueue();
    if (!silent && isEnabled() && report) sendHTML(`<b>Screening</b>\n<pre>${escapeHTMLLocal(report)}</pre>`).catch(() => {});
  }
  return report;
}
