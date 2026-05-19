import { getDB } from "./db.js";
import { getMyPositions } from "../integrations/meteora.js";
import { getWalletBalances } from "../integrations/helius.js";
import { log } from "./logger.js";

const TZ = "Asia/Jakarta";

export function toJakartaDate() {
  return new Date().toLocaleString("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .replace(/\//g, "-");
}

export async function captureDailySnapshot() {
  const db = getDB();
  const today = toJakartaDate();

  const existing = db.prepare("SELECT id FROM daily_snapshots WHERE snapshot_date = ?").get(today);
  if (existing) {
    log("debug", "snapshot", `Daily snapshot for ${today} already exists`);
    return;
  }

  const [positions, balance] = await Promise.all([
    getMyPositions({ force: true }).catch(() => null),
    getWalletBalances().catch(() => null),
  ]);

  const open = (positions?.positions || []).filter(p => !p.closed);
  const realized = positions?.total_pnl_realized ?? 0;
  const unrealized = open.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);

  db.prepare(`
    INSERT INTO daily_snapshots (snapshot_date, total_positions, open_positions, realized_pnl_usd, unrealized_pnl_usd, sol_balance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    today,
    (positions?.positions || []).length,
    open.length,
    realized,
    unrealized,
    balance?.sol ?? 0,
    Date.now()
  );

  log("info", "snapshot", `Daily snapshot ${today}: ${open.length} open, realized $${realized.toFixed(2)}, unrealized $${unrealized.toFixed(2)}, SOL ${balance?.sol ?? 0}`);
}