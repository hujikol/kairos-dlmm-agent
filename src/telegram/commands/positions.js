import { log } from "../../core/logger.js";
import { getPositionsData } from "../../core/shared-handlers.js";
import { formatPositions } from "../../core/shared-formatters.js";
import { config } from "../../config.js";
import { sendRichMessage, sendMessage } from "../../notifications/telegram.js";
import { safeSend } from "../index.js";

export async function handlePositions() {
  try {
    const { positions, total_positions } = await getPositionsData();
    if (total_positions === 0) { await sendMessage("No open positions."); return; }

    const posText = formatPositions(positions, "telegram", config.management.solMode);
    await sendRichMessage(
      `## 📊 Open Positions (${total_positions})\n\n${posText}\n\n` +
      `\`/close <n>\` to close | \`/set <n> <note>\` to set instruction`
    );
  } catch (e) {
    log("warn", "telegram", `Positions display failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
