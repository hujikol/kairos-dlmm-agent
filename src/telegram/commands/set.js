import { log } from "../../core/logger.js";
import { getMyPositions } from "../../integrations/meteora.js";
import { sendHTML } from "../../notifications/telegram.js";
import { safeSendError } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleSet(text) {
  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (!setMatch) return false;

  try {
    const idx = parseInt(setMatch[1]) - 1;
    const note = setMatch[2].trim();
    const { positions } = await getMyPositions({ force: true });
    if (idx < 0 || idx >= positions.length) { await sendHTML(`Invalid number. Use <code>/positions</code> first.`); return true; }
    const pos = positions[idx];
    const { setPositionInstruction } = await import("../../core/state/index.js");
    setPositionInstruction(pos.position, note);
    await sendHTML(`✅ Note set for <b>${escapeHTML(pos.pair)}</b>:\n"<i>${escapeHTML(note)}</i>"`);
  } catch (e) {
    log("warn", "telegram", `Set instruction failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
  return true;
}
