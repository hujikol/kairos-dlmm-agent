import { log } from "../../core/logger.js";
import { getMyPositions } from "../../integrations/meteora.js";
import { closePosition } from "../../integrations/meteora.js";
import { config } from "../../config.js";
import { sendHTML, sendMessage } from "../../notifications/telegram.js";
import { safeSendError } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleClose(text) {
  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (!closeMatch) return false;

  try {
    const idx = parseInt(closeMatch[1]) - 1;
    const { positions } = await getMyPositions({ force: true });
    if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return true; }
    const pos = positions[idx];
    await sendHTML(`Closing <b>${escapeHTML(pos.pair)}</b>...`);
    const result = await closePosition({ position_address: pos.position });
    if (result.success) {
      const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
      const claimNote = result.claim_txs?.length ? `\nClaim txs: <code>${escapeHTML(result.claim_txs.join(", "))}</code>` : "";
      await sendHTML(`✅ <b>Closed</b> ${escapeHTML(pos.pair)}\n<b>PnL:</b> ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"}  •  <b>txs:</b> <code>${escapeHTML(closeTxs?.join(", ") || "n/a")}</code>${claimNote}`);
    } else {
      await sendHTML(`❌ Close failed: <code>${escapeHTML(JSON.stringify(result))}</code>`);
    }
  } catch (e) {
    log("warn", "telegram", `Close command failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
  return true;
}
