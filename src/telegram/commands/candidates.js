import { log } from "../../core/logger.js";
import { getCandidatesData } from "../../core/shared-handlers.js";
import { formatCandidates } from "../../core/shared-formatters.js";
import { sendRichMessage, sendMessage } from "../../notifications/telegram.js";

export async function handleCandidates() {
  try {
    const { candidates } = await getCandidatesData({ limit: 5 });
    if (!candidates?.length) { await sendMessage("No candidates found."); return; }

    const table = formatCandidates(candidates, "telegram");
    await sendRichMessage(`## 🔍 Top Candidates\n\n${table}`);
  } catch (e) {
    log("warn", "telegram", `Candidates fetch failed: ${e?.message ?? e}`);
    await sendMessage(`Error: ${e?.message ?? e}`);
  }
}
