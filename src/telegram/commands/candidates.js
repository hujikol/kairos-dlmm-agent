import { log } from "../../core/logger.js";
import { getCandidatesData } from "../../core/shared-handlers.js";
import { formatCandidates } from "../../core/shared-formatters.js";
import { sendHTML, sendMessage } from "../../notifications/telegram.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleCandidates() {
  try {
    const { candidates } = await getCandidatesData({ limit: 5 });
    if (!candidates?.length) { await sendMessage("No candidates found."); return; }

    const table = formatCandidates(candidates, "telegram");
    await sendHTML(`<b>🔍 Top Candidates</b>

<pre>${escapeHTML(table)}</pre>`);
  } catch (e) {
    log("warn", "telegram", `Candidates fetch failed: ${e?.message ?? e}`);
    await sendMessage(`Error: ${e?.message ?? e}`);
  }
}
