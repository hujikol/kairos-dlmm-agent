/**
 * AgentGateway — facade over agentLoop so cycles can be tested without a real LLM.
 *
 * In production: delegates directly to agentLoop from ../agent/index.js
 * In tests: replace AgentGateway with a mock that returns controlled responses
 *
 * Usage in cycles:
 *   const gateway = new AgentGateway({ callWithRetry, modelName });
 *   const { content } = await gateway.runManagementCycle(ctx);
 *   const { content } = await gateway.runScreeningCycle(ctx);
 */

import { agentLoop } from "../agent/index.js";
import { config } from "../config.js";

export class AgentGateway {
  /**
   * @param {object} opts
   * @param {Function} [opts.callWithRetry] — optional override (for test injection)
   * @param {string}    [opts.modelName]     — optional model override
   */
  constructor({ callWithRetry, modelName } = {}) {
    this._callWithRetry = callWithRetry;
    this._modelName = modelName;
  }

  /**
   * Run the management agent (role: MANAGER) with the given cycle context.
   *
   * @param {object} ctx
   * @param {string}   ctx.actionBlocks        — pre-built management action prompt block
   * @param {Array}    ctx.actionPositions      — positions needing action
   * @param {object}   ctx.currentBalance       — wallet balances
   * @param {object}   ctx.livePositions        — full positions object
   * @param {number}   [ctx.maxSteps]           — defaults to config.llm.managerMaxSteps
   * @param {string}   [ctx.model]              — defaults to config.llm.managementModel
   * @returns {Promise<{ content: string }>}
   */
  async runManagementCycle({
    actionBlocks,
    actionPositions,
    currentBalance,
    livePositions,
    maxSteps = null,
    model = null,
  }) {
    const effectiveMaxSteps =
      maxSteps ?? config.llm.managerMaxSteps ?? Math.min(config.llm.maxSteps, 10);
    const effectiveModel = model ?? this._modelName ?? config.llm.managementModel;

    return agentLoop(
      `
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `,
      effectiveMaxSteps,
      [],
      "MANAGER",
      effectiveModel,
      2048,
      { portfolio: currentBalance, positions: livePositions }
    );
  }

  /**
   * Run the screening agent (role: SCREENER) with the given cycle context.
   *
   * @param {object} ctx
   * @param {string}   ctx.candidateBlocks     — pre-built candidate prompt blocks
   * @param {number}   ctx.passingCount         — number of passing candidates
   * @param {object}   ctx.currentBalance       — wallet balances
   * @param {object}   ctx.preBalance           — pre-fetched balance
   * @param {object}   ctx.prePositions         — pre-fetched positions
   * @param {object}   ctx.strategyBlock        — pre-built strategy + phase prompt block
   * @param {number}   ctx.deployAmount         — SOL amount to deploy
   * @param {object}   ctx.pnl                  — daily PnL object { realized, threshold, lossLimit }
   * @param {boolean}  ctx.canDeploy            — false in "preserve" mode
   * @param {string}   ctx.screeningMode        — "normal" | "preserve"
   * @param {number}   [ctx.maxSteps]           — defaults to config.llm.screenerMaxSteps
   * @param {string}   [ctx.model]              — defaults to config.llm.screeningModel
   * @returns {Promise<{ content: string }>}
   */
  async runScreeningCycle({
    candidateBlocks,
    passingCount,
    currentBalance,
    preBalance,
    prePositions,
    strategyBlock,
    deployAmount,
    pnl,
    canDeploy,
    _screeningMode,
    hiveLessonsBlock = null,
    maxSteps = null,
    model = null,
  }) {
    const effectiveMaxSteps = maxSteps ?? config.llm.screenerMaxSteps ?? 5;
    const effectiveModel = model ?? this._modelName ?? config.llm.screeningModel;

    const modeNote =
      !canDeploy
        ? `\nNOTE: Daily profit target has been met. This is a REDUCED screening cycle — review candidates but do NOT deploy new positions today.`
        : "";

    const hiveBlock = hiveLessonsBlock
      ? `\nHIVEMIND LESSONS (from collective agents — use as supplementary signal, your own analysis takes priority):\n${hiveLessonsBlock}\n`
      : "";

    const goal = `
SCREENING CYCLE${modeNote}
${strategyBlock}${hiveBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

CONVICTION SIZING MATRIX (enforced by safety check):
- very_high: LPers confirm + smart wallets present + strong fundamentals → ${prePositions.total_positions === 0 ? '1.05' : '0.70'} SOL
  (3x = 1.05 SOL only allowed at 0 positions; 1+ positions caps at 0.70 SOL)
- high: Good fundamentals, LPers match → 0.53 SOL
- normal: Standard pass → 0.35 SOL
Declare conviction in deploy_position. The safety layer computes the exact amount from this matrix — if you specify a different amount_y, it will be overridden.
Daily PnL today: $${(pnl.realized || 0).toFixed(2)} (profit target: $${pnl.threshold}, loss limit: $${pnl.lossLimit})

PRE-LOADED CANDIDATES (${passingCount} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Review each candidate's simulation results (sim: line). Prefer pools with passes=YES, low risk_score, and high confidence.
2. Pick the best candidate based on narrative quality, smart wallets, pool metrics, and simulation output.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   BIN PLACEMENT: Position range so current price is CENTERED in your range (not all below). Calculate:
     - For normal/high volatility (3+): total_bins = round(35 + (volatility/5)*34) clamped to [35,69]
       min_bin = active_bin - floor(total_bins * 0.4), max_bin = active_bin + ceil(total_bins * 0.6)
     - For low volatility (≤2): min_bin = active_bin - 20, max_bin = active_bin + 5 (narrow near current)
     - For very high volatility (≥7): bins_below=69, bins_above=10 (wide range with buffer above for upward moves)
   Example: active_bin=100, volatility=5 → total=69 → min_bin=72, max_bin=141
4. Report in this exact format (no tables, no extra sections):
    *Decision:* DEPLOYED PAIR
    *pool:* <name> | <pool address>
    *amount:* <deploy amount> SOL | *strategy*=<strategy> | *active_bin*=<bin>
    *metrics:* bin_step=X | fee=X% | fee_tvl=X% | volume=$X | tvl=$X | volatility=X | organic=X | mcap=$X
    *holder_audit:* top10=X% | bots=X% | fees=XSOL | token_age=Xh
    *okx:* risk=X | bundle=X% | sniper=X% | suspicious=X% | ath=X% | rugpull=Y/N | wash=Y/N
    *smart_wallets:* <names or none>
    *range:* minPrice→maxPrice (downside=(minPrice/maxPrice-1)*100%)
    *sim:* daily_fees=$X | est_IL=$X | net_daily=$X | risk=X/100 | confidence=X/100
    *narrative:* <1-2 sentences on what the token/pool is and why it has attention>
    *analysis:* <2-4 sentences covering why this setup is attractive right now, key risks, and what outweighed the alternatives>
    *reason:* <one decisive sentence explaining why this pool won over the rest>
    *rejected:* <one short sentence on why the next best alternatives were passed over>
5. If no pool qualifies, report in this exact format instead:
    *Decision:* NO DEPLOY
    *analysis:* <2-4 sentences explaining why current candidates were rejected>
    *rejected:* <short semicolon-separated reasons for the top candidates that were skipped>
    `;

    return agentLoop(
      goal,
      effectiveMaxSteps,
      [],
      "SCREENER",
      effectiveModel,
      2048,
      { portfolio: preBalance, positions: prePositions }
    );
  }
}

/**
 * Default gateway instance — used by cycles.js unless overridden.
 * Tests can replace this with a mock before importing cycles.
 */
export const defaultGateway = new AgentGateway();
