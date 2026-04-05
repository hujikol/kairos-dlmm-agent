/**
 * Dev (deployer) blocklist — deployer wallet addresses that should never be deployed into.
 *
 * Agent/user can add deployers via Telegram ("block this deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before the pool list reaches the LLM.
 */

import { getDB } from "../core/db.js";
import { log } from "../core/logger.js";

export function isDevBlocked(devWallet) {
  if (!devWallet) return false;
  const db = getDB();
  const row = db.prepare('SELECT 1 FROM dev_blocklist WHERE wallet = ?').get(devWallet);
  return !!row;
}

export function getBlockedDevs() {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM dev_blocklist').all();
  return Object.fromEntries(rows.map(r => [r.wallet, { label: r.label, reason: r.reason, added_at: r.added_at }]));
}

export function blockDev({ wallet, reason, label }) {
  if (!wallet) return { error: "wallet required" };
  const db = getDB();
  const existing = db.prepare('SELECT * FROM dev_blocklist WHERE wallet = ?').get(wallet);
  if (existing) return { already_blocked: true, wallet, label: existing.label, reason: existing.reason };
  
  db.prepare(`
    INSERT INTO dev_blocklist (wallet, label, reason, added_at)
    VALUES (?, ?, ?, ?)
  `).run(wallet, label || "unknown", reason || "no reason provided", new Date().toISOString());
  
  log("info", "dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({ wallet }) {
  if (!wallet) return { error: "wallet required" };
  const db = getDB();
  const entry = db.prepare('SELECT * FROM dev_blocklist WHERE wallet = ?').get(wallet);
  if (!entry) return { error: `Wallet ${wallet} not on dev blocklist` };
  
  db.prepare('DELETE FROM dev_blocklist WHERE wallet = ?').run(wallet);
  log("info", "dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs() {
  const db = getDB();
  const entries = db.prepare('SELECT * FROM dev_blocklist').all();
  return { count: entries.length, blocked_devs: entries };
}
