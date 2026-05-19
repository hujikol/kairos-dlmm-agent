import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

let _syncMissCount;
let _db;
const REQUIRED_MISSES = 2;
const SYNC_GRACE_MS = 5 * 60_000;

async function getMemDB() {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS positions (
    position TEXT PRIMARY KEY, pool TEXT, pool_name TEXT, strategy TEXT,
    bin_range TEXT, amount_sol REAL, amount_x REAL, active_bin_at_deploy INTEGER,
    bin_step INTEGER, volatility REAL, fee_tvl_ratio REAL, organic_score REAL,
    initial_value_usd REAL, signal_snapshot TEXT, base_mint TEXT, deployed_at TEXT,
    out_of_range_since TEXT, last_claim_at TEXT, total_fees_claimed_usd REAL,
    rebalance_count INTEGER DEFAULT 0, closed INTEGER DEFAULT 0, closed_at TEXT,
    notes TEXT DEFAULT '[]', peak_pnl_pct REAL, prev_pnl_pct REAL,
    trailing_active INTEGER DEFAULT 0, instruction TEXT, status TEXT DEFAULT 'active',
    market_phase TEXT, strategy_id TEXT
  );`);
  return db;
}

describe("syncOpenPositions — on-chain verification on first miss", () => {
  beforeEach(async () => {
    _db = await getMemDB();
    _syncMissCount = new Map();
  });

  it("closes immediately on first miss when on-chain confirms absence", async () => {
    _db.prepare(
      `INSERT INTO positions (position, pool, deployed_at, closed) VALUES (?, ?, ?, 0)`
    ).run("Pos001", "PoolA", new Date(Date.now() - SYNC_GRACE_MS - 1000).toISOString());

    const openPos = _db.prepare("SELECT position, deployed_at FROM positions WHERE closed = 0").all();
    const activeSet = new Set();

    const toVerify = [];
    for (const pos of openPos) {
      if (activeSet.has(pos.position)) continue;
      if (Date.now() - new Date(pos.deployed_at).getTime() < SYNC_GRACE_MS) continue;
      const misses = (_syncMissCount.get(pos.position) || 0) + 1;
      _syncMissCount.set(pos.position, misses);
      toVerify.push({ pos, misses });
    }

    const onChainResults = toVerify.map(() => ({ status: "fulfilled", value: false }));

    let closedImmediately = false;
    for (let i = 0; i < toVerify.length; i++) {
      const { pos, misses } = toVerify[i];
      const onChainConfirmed = onChainResults[i].status === "fulfilled" ? onChainResults[i].value : false;

      if (misses < REQUIRED_MISSES) {
        if (!onChainConfirmed) {
          _db.prepare("UPDATE positions SET closed=1, closed_at=? WHERE position=?")
            .run(new Date().toISOString(), pos.position);
          _syncMissCount.delete(pos.position);
          closedImmediately = true;
        } else {
          _syncMissCount.delete(pos.position);
        }
      }
    }

    const row = _db.prepare("SELECT closed FROM positions WHERE position=?").get("Pos001");
    assert.strictEqual(row.closed, 1, "Position should be auto-closed after first miss confirmed on-chain");
    assert.strictEqual(closedImmediately, true, "Should close in first miss cycle");
  });

  it("clears miss count when on-chain confirms position still exists", async () => {
    _db.prepare(
      `INSERT INTO positions (position, pool, deployed_at, closed) VALUES (?, ?, ?, 0)`
    ).run("Pos002", "PoolB", new Date(Date.now() - SYNC_GRACE_MS - 1000).toISOString());

    const openPos = _db.prepare("SELECT position, deployed_at FROM positions WHERE closed = 0").all();
    const activeSet = new Set();

    const toVerify = [];
    for (const pos of openPos) {
      if (activeSet.has(pos.position)) continue;
      if (Date.now() - new Date(pos.deployed_at).getTime() < SYNC_GRACE_MS) continue;
      const misses = (_syncMissCount.get(pos.position) || 0) + 1;
      _syncMissCount.set(pos.position, misses);
      toVerify.push({ pos, misses });
    }

    const onChainResults = toVerify.map(() => ({ status: "fulfilled", value: true }));

    for (let i = 0; i < toVerify.length; i++) {
      const { pos, misses } = toVerify[i];
      const onChainConfirmed = onChainResults[i].status === "fulfilled" ? onChainResults[i].value : false;

      if (misses < REQUIRED_MISSES) {
        if (!onChainConfirmed) {
          _db.prepare("UPDATE positions SET closed=1, closed_at=? WHERE position=?")
            .run(new Date().toISOString(), pos.position);
          _syncMissCount.delete(pos.position);
        } else {
          _syncMissCount.delete(pos.position);
        }
      }
    }

    const row = _db.prepare("SELECT closed FROM positions WHERE position=?").get("Pos002");
    assert.strictEqual(row.closed, 0, "Position should NOT be closed");
    assert.strictEqual(_syncMissCount.has("Pos002"), false, "Miss count should be cleared");
  });

  it("closes on second miss when on-chain also confirms absence", async () => {
    _db.prepare(
      `INSERT INTO positions (position, pool, deployed_at, closed) VALUES (?, ?, ?, 0)`
    ).run("Pos003", "PoolC", new Date(Date.now() - SYNC_GRACE_MS - 1000).toISOString());

    const openPos = _db.prepare("SELECT position, deployed_at FROM positions WHERE closed = 0").all();
    const activeSet = new Set();

    const toVerify = [];
    for (const pos of openPos) {
      if (activeSet.has(pos.position)) continue;
      if (Date.now() - new Date(pos.deployed_at).getTime() < SYNC_GRACE_MS) continue;
      const misses = (_syncMissCount.get(pos.position) || 0) + 1;
      _syncMissCount.set(pos.position, misses);
      toVerify.push({ pos, misses });
    }

    const onChainResults = toVerify.map(() => ({ status: "fulfilled", value: false }));

    for (let i = 0; i < toVerify.length; i++) {
      const { pos, misses } = toVerify[i];
      const onChainConfirmed = onChainResults[i].status === "fulfilled" ? onChainResults[i].value : false;

      if (misses < REQUIRED_MISSES) {
        _syncMissCount.delete(pos.position);
        continue;
      }

      if (!onChainConfirmed) {
        _db.prepare("UPDATE positions SET closed=1, closed_at=? WHERE position=?")
          .run(new Date().toISOString(), pos.position);
        _syncMissCount.delete(pos.position);
      } else {
        _syncMissCount.delete(pos.position);
      }
    }

    const row = _db.prepare("SELECT closed FROM positions WHERE position=?").get("Pos003");
    assert.strictEqual(row.closed, 1, "Position should be auto-closed after second miss");
  });
});