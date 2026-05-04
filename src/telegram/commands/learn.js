import { log } from "../../core/logger.js";
import { agentLoop } from "../../agent/index.js";
import { config } from "../../config.js";
import { stripThink } from "../../tools/caveman.js";
import { sendHTML } from "../../notifications/telegram.js";
import { safeSendError } from "../index.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleLearn(text) {
  const learnMatch = text.match(/^\/learn\s*(.*)$/i);
  if (!learnMatch) return false;

  try {
    const poolArg = learnMatch[1].trim() || null;
    let prompt;

    if (poolArg) {
      prompt = `Study top LPers on pool ${poolArg} by calling study_top_lpers. Summarize what you learned.`;
    } else {
      prompt = `Study top LPers across top 10 pools from get_top_candidates. Call study_top_lpers for each pool, then summarize patterns you observe.`;
    }

    const { content } = await agentLoop(prompt, config.llm.maxSteps, [], "GENERAL", config.llm.generalModel, null, { requireTool: true });
    await sendHTML(`<pre>${escapeHTML(stripThink(content))}</pre>`);
  } catch (e) {
    log("warn", "telegram", `Learn command failed: ${e?.message ?? e}`);
    safeSendError(e);
  }
  return true;
}
