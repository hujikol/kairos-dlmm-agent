import { log } from "../../core/logger.js";
import { getStatusData } from "../../core/shared-handlers.js";
import { config } from "../../config.js";
import { mdTable } from "../../core/shared-formatters.js";
import { sendRichMessage } from "../../notifications/telegram.js";
import { safeSend } from "../index.js";

export async function handleStatus() {
  try {
    const { wallet, positions, total_positions } = await getStatusData();
    const cur = config.management.solMode ? "◎" : "$";

    const posBlock = total_positions > 0
      ? mdTable(
          ["ID", "Pair", "PnL", "Value"],
          positions.map((p, i) => [
            i + 1,
            p.pair.slice(0, 10),
            `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`,
            `${cur}${p.total_value_usd}`.slice(0, 6),
          ]),
          ["l", "l", "r", "r"],
        )
      : "_No open positions._";

    await sendRichMessage(
      `## 📊 Status Report\n\n${posBlock}\n\n` +
      `**Wallet:** ${wallet.sol.toFixed(4)} SOL ($${wallet.sol_usd})\n` +
      `**SOL Price:** $${wallet.sol_price}`
    );
  } catch (e) {
    log("warn", "telegram", `Status report failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
