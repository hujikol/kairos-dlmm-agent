/** Deterministic deployment gateway. All writes retain executor safety checks. */
import { config } from "../config.js";
import { executeTool } from "../tools/executor.js";
import { chooseCandidate } from "./decision-rules.js";
import { getActiveRules } from "./rule-memory.js";

export class AgentGateway {
  async runScreeningCycle({ candidates, deployAmount, solPrice, canDeploy, rules = getActiveRules() }) {
    const selected = canDeploy && deployAmount > 0 ? chooseCandidate(candidates, rules) : null;
    if (!selected) return { content: "NO DEPLOY: no candidate passed all entry rules.", selected: null };
    const { pool } = selected;
    const strategy = config.strategy.strategy;
    const result = await executeTool("deploy_position", {
      pool_address: pool.pool, pool_name: pool.name, base_mint: pool.base.mint,
      initial_value_usd: deployAmount * solPrice,
      amount_y: deployAmount, amount_x: 0, conviction: "normal", strategy,
      bins_below: config.strategy.binsBelow,
      bins_above: strategy === "bid_ask" ? 0 : config.strategy.binsAbove,
      bin_step: pool.bin_step, volatility: pool.volatility,
      fee_tvl_ratio: pool.daily_fee_tvl_ratio ?? pool.fee_active_tvl_ratio, organic_score: pool.organic_score,
    });
    const success = result?.success === true && !result.blocked && !result.error;
    return { content: `${success ? "DEPLOY EXECUTED" : result?.dry_run ? "DRY RUN" : "DEPLOY BLOCKED/FAILED"}: ${pool.name || pool.pool} | ${result?.reason || result?.error || result?.position || "no confirmed position"}`,
      selected, result, rules };
  }
}
export const defaultGateway = new AgentGateway();
