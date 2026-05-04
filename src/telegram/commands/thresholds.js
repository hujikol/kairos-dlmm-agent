import { log } from "../../core/logger.js";
import { getThresholdsData } from "../../core/shared-handlers.js";
import { config } from "../../config.js";
import { sendHTML, sendMessage } from "../../notifications/telegram.js";
import { safeSend } from "../index.js";

export async function handleThresholds() {
  try {
    const { screening, management, performance } = getThresholdsData();
    const s = screening;
    const m = management;

    let msg = "⚙️ *BOT CONFIGURATION*\n\n";

    let sc = "🔍 SCREENING\n";
    sc += "────────────────────\n";
    sc += `fee_aTVL_min    ${s.minFeeActiveTvlRatio}%\n`;
    sc += `organic_min     ${s.minOrganic}\n`;
    sc += `holders_min     ${s.minHolders}\n`;
    sc += `tvl_min         $${(s.minTvl/1000).toFixed(1)}k\n`;
    sc += `vol_min         $${(s.minVolume/1000).toFixed(1)}k\n`;
    sc += `mcap_min        $${((s.minMcap ?? 0)/1000).toFixed(1)}k\n`;
    sc += `mcap_max        $${((s.maxMcap ?? 0)/1000000).toFixed(1)}M\n`;
    sc += `age_min         ${s.minTokenAgeHours ?? 0}h\n`;
    sc += `timeframe       ${s.timeframe}\n`;
    msg += "```\n" + sc + "```\n";

    let mg = "💼 MANAGEMENT\n";
    mg += "────────────────────\n";
    mg += `deploy_amt      ${m.deployAmountSol} SOL\n`;
    mg += `max_pos         ${m.maxPositions}\n`;
    mg += `min_open        ${m.minSolToOpen} SOL\n`;
    mg += `gas_reserve     ${m.gasReserve} SOL\n`;
    mg += `strategy        ${m.strategy}\n`;
    msg += "```\n" + mg + "```\n";

    let rs = "🛡️ RISK & EXIT\n";
    rs += "────────────────────\n";
    rs += `stop_loss       ${m.stopLossPct}%\n`;
    rs += `tp_fee_pct      ${m.takeProfitFeePct}%\n`;
    rs += `trailing_tp     ${m.trailingTakeProfit ? "ON" : "OFF"}\n`;
    rs += `  trigger       ${m.trailingTriggerPct}%\n`;
    rs += `  drop          ${m.trailingDropPct}%\n`;
    rs += `oor_wait        ${m.outOfRangeWaitMinutes}m\n`;
    msg += "```\n" + rs + "```\n";

    if (performance) {
      msg += `<i>Stats from ${performance.total_positions_closed} closed positions:</i>\n` +
             `<b>Win Rate:</b> ${performance.win_rate_pct}%  •  <b>Avg PnL:</b> ${performance.avg_pnl_pct}%`;
    }

    await sendHTML(msg);
  } catch (e) {
    log("warn", "telegram", `Thresholds display failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
