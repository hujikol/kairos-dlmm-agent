import { log } from "../../core/logger.js";
import { generateBriefing } from "../../notifications/briefing.js";
import { sendHTML } from "../../notifications/telegram.js";
import { safeSendError } from "../index.js";

export async function handleBriefing() {
  try {
    const briefing = await generateBriefing();
    await sendHTML(briefing);
  } catch (e) {
    log("warn", "telegram", `Briefing generation failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
}
