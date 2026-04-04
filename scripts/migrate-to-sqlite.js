import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDB } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const STRATEGY_FILE = path.join(ROOT, "strategy-library.json");
const WEIGHTS_FILE = path.join(ROOT, "signal-weights.json");
const TOKEN_BLACKLIST_FILE = path.join(ROOT, "token-blacklist.json");
const DEV_BLOCKLIST_FILE = path.join(ROOT, "dev-blocklist.json");
const DEPLOYER_BLACKLIST_FILE = path.join(ROOT, "deployer-blacklist.json");

async function migrate() {
  const db = getDB();

  // 1. Strategies
  if (fs.existsSync(STRATEGY_FILE)) {
    const data = JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf8"));
    const { active, strategies } = data;
    
    db.transaction(() => {
      for (const [id, s] of Object.entries(strategies)) {
        db.prepare(`
          INSERT OR REPLACE INTO strategies (
            id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw, added_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          s.id, s.name, s.author, s.lp_strategy,
          JSON.stringify(s.token_criteria), JSON.stringify(s.entry),
          JSON.stringify(s.range), JSON.stringify(s.exit),
          s.best_for, s.raw || "", s.added_at, s.updated_at
        );
      }
      if (active) {
        db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('active_strategy', active);
      }
    })();
    console.log(`Migrated ${Object.keys(strategies || {}).length} strategies.`);
  }

  // 2. Signal Weights
  if (fs.existsSync(WEIGHTS_FILE)) {
    const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
    db.transaction(() => {
      db.prepare(`
        INSERT OR REPLACE INTO signal_weights (id, weights, last_recalc, recalc_count)
        VALUES (1, ?, ?, ?)
      `).run(JSON.stringify(data.weights), data.last_recalc, data.recalc_count);

      if (data.history) {
        for (const h of data.history) {
          db.prepare(`
            INSERT INTO signal_weights_history (timestamp, changes, window_size, win_count, loss_count)
            VALUES (?, ?, ?, ?, ?)
          `).run(h.timestamp, JSON.stringify(h.changes), h.window_size, h.win_count, h.loss_count);
        }
      }
    })();
    console.log(`Migrated signal weights and ${data.history?.length || 0} history records.`);
  }

  // 3. Token Blacklist
  if (fs.existsSync(TOKEN_BLACKLIST_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_BLACKLIST_FILE, "utf8"));
    db.transaction(() => {
      for (const [mint, info] of Object.entries(data)) {
        db.prepare(`
          INSERT OR REPLACE INTO token_blacklist (mint, symbol, reason, added_at, added_by)
          VALUES (?, ?, ?, ?, ?)
        `).run(mint, info.symbol, info.reason, info.added_at, info.added_by);
      }
    })();
    console.log(`Migrated ${Object.keys(data).length} blacklisted tokens.`);
  }

  // 4. Dev Blocklist
  if (fs.existsSync(DEV_BLOCKLIST_FILE)) {
    const data = JSON.parse(fs.readFileSync(DEV_BLOCKLIST_FILE, "utf8"));
    db.transaction(() => {
      for (const [wallet, info] of Object.entries(data)) {
        db.prepare(`
          INSERT OR REPLACE INTO dev_blocklist (wallet, label, reason, added_at)
          VALUES (?, ?, ?, ?)
        `).run(wallet, info.label, info.reason, info.added_at);
      }
    })();
    console.log(`Migrated ${Object.keys(data).length} blocked developers.`);
  }

  // 5. Deployer Blacklist (legacy array format)
  if (fs.existsSync(DEPLOYER_BLACKLIST_FILE)) {
    const data = JSON.parse(fs.readFileSync(DEPLOYER_BLACKLIST_FILE, "utf8"));
    const addresses = data.addresses || [];
    db.transaction(() => {
      for (const wallet of addresses) {
        db.prepare(`
          INSERT OR IGNORE INTO dev_blocklist (wallet, label, reason, added_at)
          VALUES (?, ?, ?, ?)
        `).run(wallet, "legacy_blacklist", "imported from deployer-blacklist.json", new Date().toISOString());
      }
    })();
    console.log(`Migrated ${addresses.length} legacy blacklisted deployers.`);
  }

  console.log("Migration complete!");
}

migrate().catch(console.error);
