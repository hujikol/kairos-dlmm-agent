import { log } from "../../core/logger.js";
import { getBalanceData } from "../../core/shared-handlers.js";
import { formatBalance } from "../../core/shared-formatters.js";
import { sendRichMessage, sendMessage } from "../../notifications/telegram.js";
import { safeSend } from "../index.js";

export async function handleBalance() {
  try {
    const data = await getBalanceData();
    await sendRichMessage(`## 💰 Wallet Balance\n\n${formatBalance(data, "telegram")}`);
  } catch (e) {
    log("warn", "telegram", `Wallet balance failed: ${e?.message ?? e}`);
    await safeSend(`Error: ${e?.message ?? e}`);
  }
}
