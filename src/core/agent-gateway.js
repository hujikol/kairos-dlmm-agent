/** Deterministic deployment gateway. All writes retain executor safety checks. */
import { config } from "../config.js";
import { executeTool } from "../tools/executor.js";
import { chooseCandidate } from "./decision-rules.js";
import { getActiveRules } from "./rule-memory.js";

export class AgentGateway {
  /**
   * Convert a target price-width percentage into a bin count for a given bin step.
   * A fixed bin count means a different range width on every pool; this keeps the
   * covered width constant (e.g. 12%) regardless of the pool's bin step.
   * side "above" widens upward from spot, "below" widens downward.
   */
  _binsForPercent(pct, binStep, fallback, side = "above") {
    const p = Number(pct), bs = Number(binStep);
    if (!(p > 0) || !(bs > 0) || p >= 1) return fallback;
    const factor = side === "below" ? 1 - p : 1 + p;
    const bins = Math.ceil(Math.abs(Math.log(factor) / Math.log(1 + bs / 10000)));
    return Math.max(1, Math.min(1400, bins));
  }

  async runScreeningCycle({ candidates, deployAmount, solPrice, canDeploy, rules = getActiveRules() }) {
    const selected = canDeploy && deployAmount > 0 ? chooseCandidate(candidates, rules) : null;
    if (!selected) return { content: "NO DEPLOY: no candidate passed all entry rules.", selected: null };
    const { pool } = selected;
    const strategy = config.strategy.strategy;
    const targetPct = Number(config.strategy.targetRangePct) || 0;
    // Which side we are bidding on is decided by which bin side is configured.
    // Verified on-chain: bins BELOW the active bin hold SOL, bins ABOVE hold the base token.
    const wantBelow = Number(config.strategy.binsBelow) > 0;
    const binsBelow = targetPct > 0 && wantBelow
      ? this._binsForPercent(targetPct, pool.bin_step, config.strategy.binsBelow, "below")
      : config.strategy.binsBelow;
    const binsAbove = strategy === "bid_ask"
      ? 0
      : (targetPct > 0 && !wantBelow
          ? this._binsForPercent(targetPct, pool.bin_step, config.strategy.binsAbove, "above")
          : config.strategy.binsAbove);
    const result = await executeTool("deploy_position", {
      pool_address: pool.pool, pool_name: pool.name, base_mint: pool.base.mint,
      initial_value_usd: deployAmount * solPrice,
      amount_y: deployAmount, amount_x: 0, conviction: "normal", strategy,
      bins_below: binsBelow,
      bins_above: binsAbove,
      bin_step: pool.bin_step, volatility: pool.volatility,
      fee_tvl_ratio: pool.daily_fee_tvl_ratio ?? pool.fee_active_tvl_ratio, organic_score: pool.organic_score,
    });
    const success = result?.success === true && !result.blocked && !result.error;
    return { content: `${success ? "DEPLOY EXECUTED" : result?.dry_run ? "DRY RUN" : "DEPLOY BLOCKED/FAILED"}: ${pool.name || pool.pool} | ${result?.reason || result?.error || result?.position || "no confirmed position"}`,
      selected, result, rules };
  }
}
export const defaultGateway = new AgentGateway();
