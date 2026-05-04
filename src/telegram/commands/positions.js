import { log } from "../../core/logger.js";
import { getPositionsData } from "../../core/shared-handlers.js";
import { formatPositions } from "../../core/shared-formatters.js";
import { config } from "../../config.js";
import { sendHTML, sendMessage } from "../../notifications/telegram.js";
import { safeSend } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handlePositions() {
  try {
    const { positions, total_positions } = await getPositionsData();
    if (total_positions === 0) { await sendMessage("No open positions."); return; }

    const posText = formatPositions(positions, "telegram", config.management.solMode);
    await sendHTML(
      `<b>📊 Open Positions (${total_positions})</b>\n\n<pre>${escapeHTML(posText)}</pre>\n` +
      `<code>/close &lt;n&gt;</code> to close | <code>/set &lt;n&gt; &lt;note&gt;</code> to set instruction`
    );
  } catch (e) {
    log("warn", "telegram", `Positions display failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
