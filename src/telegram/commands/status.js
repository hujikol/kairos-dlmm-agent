import { log } from "../../core/logger.js";
import { getStatusData } from "../../core/shared-handlers.js";
import { config } from "../../config.js";
import { buildAsciiTable } from "../../core/shared-formatters.js";
import { sendHTML, sendMessage } from "../../notifications/telegram.js";
import { safeSend } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleStatus() {
  try {
    const { wallet, positions, total_positions } = await getStatusData();
    const cur = config.management.solMode ? "◎" : "$";

    const colWidths = [2, 10, 6, 6];
    const rows = [
      { cells: ["ID", "Pair", "PnL", "Value"] },
      ...positions.map((p, i) => ({
        align: ["right", "left", "right", "right"],
        cells: [
          String(i + 1),
          p.pair.slice(0, 10),
          `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`,
          `${cur}${p.total_value_usd}`.slice(0, 6),
        ],
      })),
    ];

    const table = buildAsciiTable(rows, colWidths);
    const posBlock = total_positions > 0 ? `<pre>${escapeHTML(table)}</pre>\n` : "<i>No open positions.</i>\n";
    await sendHTML(
      `<b>📊 Status Report</b>\n\n` +
      posBlock +
      `<b>Wallet:</b> ${wallet.sol.toFixed(4)} SOL ($${wallet.sol_usd})\n` +
      `<b>SOL Price:</b> $${wallet.sol_price}`
    );
  } catch (e) {
    log("warn", "telegram", `Status report failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
