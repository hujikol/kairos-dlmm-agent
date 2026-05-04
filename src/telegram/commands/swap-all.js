import { log } from "../../core/logger.js";
import { getSwapAllResult } from "../../core/shared-handlers.js";
import { sendHTML } from "../../notifications/telegram.js";
import { safeSendError } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleSwapAll() {
  try {
    await sendHTML("🔄 <b>Sweeping all tokens to SOL...</b>");
    const result = await getSwapAllResult();
    if (result.success) {
      const count = result.swapped?.length || 0;
      if (count === 0) {
        await sendHTML("No eligible tokens found to swap.");
      } else {
        const symbols = result.swapped.map(s => s.input_mint?.slice(0, 4)).join(", ");
        await sendHTML(`✅ <b>Sweep Complete</b>\nSwapped ${count} tokens (<code>${escapeHTML(symbols)}</code>) to SOL.`);
      }
    } else {
      await sendHTML(`❌ Sweep failed: <code>${escapeHTML(result.error)}</code>`);
    }
  } catch (e) {
    log("warn", "telegram", `Swap-all failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
}
