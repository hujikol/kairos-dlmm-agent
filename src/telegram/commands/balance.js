import { log } from "../../core/logger.js";
import { getBalanceData } from "../../core/shared-handlers.js";
import { formatBalance } from "../../core/shared-formatters.js";
import { sendHTML, sendMessage } from "../../notifications/telegram.js";
import { safeSend, safeSendError } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleBalance() {
  try {
    const data = await getBalanceData();
    await sendHTML(`<b>💰 Wallet Balance</b>

<pre>${escapeHTML(formatBalance(data, "telegram"))}</pre>
<b>Total:</b> $${data.total_usd.toFixed(2)}`);
  } catch (e) {
    log("warn", "telegram", `Wallet balance failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
