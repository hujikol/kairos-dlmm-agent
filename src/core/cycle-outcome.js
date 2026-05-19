import { getDB } from "./db.js";

export function startCycleOutcome(cycleType) {
  const db = getDB();
  const startedAt = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO cycle_outcomes (cycle_type, started_at) VALUES (?, ?)`
  ).run(cycleType, startedAt);
  return result.lastInsertRowid;
}

export function updateCycleOutcome(id, patch) {
  const db = getDB();
  const allowed = [
    "candidates_seen",
    "filters_passed",
    "llm_calls",
    "rpc_calls",
    "deploy_attempted",
    "deploy_confirmed",
    "deploy_position_id",
    "duration_ms",
    "pnl_at_close",
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE cycle_outcomes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function finalizeCycleOutcome(id) {
  const db = getDB();
  const row = db.prepare(`SELECT started_at FROM cycle_outcomes WHERE id = ?`).get(id);
  if (!row) return;
  const durationMs = Date.now() - new Date(row.started_at).getTime();
  const finalizedAt = new Date().toISOString();
  db.prepare(
    `UPDATE cycle_outcomes SET duration_ms = ?, finalized_at = ? WHERE id = ?`
  ).run(durationMs, finalizedAt, id);
}

export function recordDeployConfirmed(id, positionId) {
  const db = getDB();
  db.prepare(
    `UPDATE cycle_outcomes
       SET deploy_confirmed = 1, deploy_position_id = ?, deploy_attempted = 1
     WHERE id = ?`
  ).run(positionId, id);
}