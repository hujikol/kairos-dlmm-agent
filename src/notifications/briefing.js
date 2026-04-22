import { getDB } from "../core/db.js";
import { getPerformanceSummary } from "../core/lessons.js";

export async function generateBriefing() {
  const db = await getDB();
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const openedLast24h = db.prepare(
    'SELECT * FROM positions WHERE deployed_at >= ? AND closed = 0'
  ).all(last24h);

  const closedLast24h = db.prepare(
    'SELECT * FROM performance WHERE closed_at >= ?'
  ).all(last24h);

  const totalPnLUsd = closedLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = closedLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  const openPositions = db.prepare('SELECT * FROM positions WHERE closed = 0').all();
  const perfSummary = await getPerformanceSummary();

  const winRate24h = closedLast24h.length > 0
    ? Math.round((closedLast24h.filter(p => p.pnl_usd > 0).length / closedLast24h.length) * 100)
    : null;

  const lessonsLast24h = db.prepare(
    'SELECT * FROM lessons WHERE created_at >= ?'
  ).all(last24h);

  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    winRate24h !== null
      ? `📈 Win Rate (24h): ${winRate24h}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}
