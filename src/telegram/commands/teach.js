import { log } from "../../core/logger.js";
import { getLearningStats, pinLesson, unpinLesson, rateLesson, listLessons } from "../../core/lessons.js";
import { sendHTML } from "../../notifications/telegram.js";
import { escapeHTML } from "../../core/cycle-helpers.js";

export async function handleTeachCommand(sub, { sendHTML, escapeHTML }) {
  const stats = getLearningStats();
  const pinMatch = sub.match(/^pin\s+(.+)$/i);
  if (pinMatch) {
    const result = pinLesson(pinMatch[1].trim());
    if (result.found) {
      await sendHTML(`📌 Lesson pinned:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
    } else {
      await sendHTML(`Lesson <code>${escapeHTML(pinMatch[1])}</code> not found.`);
    }
    return;
  }

  const unpinMatch = sub.match(/^unpin\s+(.+)$/i);
  if (unpinMatch) {
    const result = unpinLesson(unpinMatch[1].trim());
    if (result.found) {
      await sendHTML(`Lesson unpinned:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
    } else {
      await sendHTML(`Lesson <code>${escapeHTML(unpinMatch[1])}</code> not found.`);
    }
    return;
  }

  const rateMatch = sub.match(/^rate\s+(\S+)\s+(useful|useless)$/i);
  if (rateMatch) {
    const result = rateLesson(rateMatch[1], rateMatch[2].toLowerCase());
    if (result.error) {
      await sendHTML(`<code>${escapeHTML(result.error)}</code>`);
    } else if (result.found) {
      const icon = result.rating === "useful" ? "👍" : "👎";
      await sendHTML(`${icon} Lesson rated as <b>${result.rating}</b>:\n<code>${escapeHTML(result.rule.slice(0, 120))}</code>`);
    } else {
      await sendHTML(`Lesson <code>${escapeHTML(rateMatch[1])}</code> not found.`);
    }
    return;
  }

  if (/^stats$/i.test(sub)) {
    let msg = `<b>Learning System Status</b>\n\n`;
    msg += `Closed positions: <b>${stats.performance_records}</b>\n`;
    msg += `Near-miss records: <b>${stats.near_misses}</b>\n`;
    msg += `Total lessons: <b>${stats.total_lessons}</b>\n`;
    msg += `Archived records: <b>${stats.archived_records}</b>\n`;
    if (stats.overall_win_rate != null) msg += `\nWin rate: <b>${stats.overall_win_rate}%</b>\n`;
    if (stats.total_pnl_usd != null) msg += `Total PnL: <b>$${stats.total_pnl_usd}</b>\n`;
    if (stats.avg_pnl_pct != null) msg += `Avg PnL: <b>${stats.avg_pnl_pct}%</b>\n`;
    if (stats.near_miss_avg_pnl_pct != null) msg += `Near-miss avg PnL: <b>${stats.near_miss_avg_pnl_pct}%</b>\n`;
    msg += `\nPinned: ${stats.pinned_lessons} | Useful: ${stats.rated_useful} | Useless: ${stats.rated_useless}\n`;
    msg += `Evolution cycles: ${stats.evolution_cycles}\n`;
    if (stats.current_thresholds && Object.keys(stats.current_thresholds).length > 0) {
      msg += `\n<b>Current thresholds:</b>\n`;
      msg += `maxBinStep: ${stats.current_thresholds.maxBinStep}\n`;
      msg += `minFeeActiveTvlRatio: ${stats.current_thresholds.minFeeActiveTvlRatio}\n`;
      msg += `minOrganic: ${stats.current_thresholds.minOrganic}`;
    }
    await sendHTML(msg);
    return;
  }

  if (/^list/i.test(sub)) {
    const roleArg = sub.split(/\s+/)[1]?.toUpperCase() || null;
    const result = listLessons({ role: roleArg, limit: 15 });
    if (result.total === 0) { await sendHTML("No lessons found."); return; }
    let msg = `<b>Lessons</b> (${result.total} total, showing ${result.lessons.length})\n\n`;
    for (const l of result.lessons) {
      const pinIcon = l.pinned ? "📌" : "";
      msg += `<code>${escapeHTML(l.id.slice(0, 8))}</code> ${pinIcon}[${l.outcome}] ${escapeHTML(l.rule.slice(0, 60))}\n`;
    }
    msg += `\n<i>Use /teach pin|rate|stats to manage</i>`;
    await sendHTML(msg);
    return;
  }

  await sendHTML(`<b>/teach</b> subcommands:\n<pre>  pin &lt;id&gt;       — pin a lesson\n  unpin &lt;id&gt;     — unpin a lesson\n  rate &lt;id&gt; useful|useless  — rate a lesson\n  stats          — learning system status\n  list [role]    — list lessons (optionally by role)</pre>`);
}

export async function handleTeach(text) {
  const teachMatch = text.match(/^\/teach\s+(.+)$/i);
  if (!teachMatch) return false;

  try {
    await handleTeachCommand(teachMatch[1].trim(), { sendHTML, escapeHTML });
  } catch (e) {
    log("warn", "telegram", `Teach command failed: ${e?.message ?? e}`);
    const { safeSendError } = await import("../index.js");
    safeSendError(e);
  }
  return true;
}
