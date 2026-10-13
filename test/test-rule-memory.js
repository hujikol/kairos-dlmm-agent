import "./setup-env.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { _injectDB, closeDB, migrate } from "../src/core/db.js";
import { _setCallWithRetry, _resetCallWithRetry } from "../src/agent/fallback.js";
import { getActiveRules, getRuleHistory, updateRules, rollbackRules } from "../src/core/rule-memory.js";

after(() => { _resetCallWithRetry(); closeDB(); });

test("AI receives training metrics only; activation, cooldown, persistence and rollback use SQLite", async () => {
  const db = new Database(":memory:");
  migrate(db);
  _injectDB(db);
  const previousDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "false";
  let calls = 0;
  _setCallWithRetry(async (_client, _model, messages, tools) => {
    calls++;
    assert.equal(tools, undefined);
    const context = JSON.parse(messages[1].content);
    assert.equal(context.training.length, 28);
    assert.equal(context.training[0].position, undefined);
    return { response: { choices: [{ message: { content: JSON.stringify({ ...context.current, minOrganic: 66 }) } }] } };
  });
  try {
    assert.equal((await updateRules()).activated, false);
    assert.equal(calls, 0, "insufficient data never calls model");
    for (let i = 0; i < 40; i++) db.prepare(`INSERT INTO performance
      (position, organic_score, volatility, fee_tvl_ratio, pnl_pct, recorded_at) VALUES (?, ?, 3, 0.1, ?, ?)`)
      .run(`pos-${i}`, i % 2 ? 70 : 60, i % 2 ? 5 : -5, new Date(1700000000000 + i * 1000).toISOString());
    assert.equal((await updateRules()).activated, true);
    assert.equal(getActiveRules().minOrganic, 66);
    assert.equal(getRuleHistory()[0].activated, 1);
    assert.equal((await updateRules()).activated, false);
    assert.equal(calls, 1, "cooldown prevents repeated model calls");
    assert.equal(rollbackRules().rules.minOrganic, 60);
    assert.equal(rollbackRules().rolledBack, false, "rollback does not repeat same update");
    db.prepare("DELETE FROM rule_updates").run();
    _setCallWithRetry(async () => ({ response: { choices: [{ message: { content: '{"minOrganic":66,"maxVolatility":10,"minFeeTvl":0.05,"deployAmount":100}' } }] } }));
    assert.equal((await updateRules()).activated, false);
    assert.equal(getActiveRules().minOrganic, 60, "invalid proposal cannot change active rules");
    assert.equal(getRuleHistory()[0].activated, 0);
    process.env.DRY_RUN = "true";
    assert.match((await updateRules()).reason, /30 eligible/);
    assert.equal(getActiveRules().minOrganic, 60);
    assert.equal(getRuleHistory().length, 0, "paper rule history stays separate");
    for (let i = 0; i < 40; i++) db.prepare("INSERT INTO paper_positions (position, closed, data) VALUES (?, 1, ?)").run(`paper-${i}`, JSON.stringify({
      organic_score: i % 2 ? 70 : 60, volatility: 3, fee_tvl_ratio: 0.1, pnl_pct: i % 2 ? 5 : -5,
      closed_at: new Date(1700000000000 + i * 1000).toISOString(), source: "paper" }));
    _setCallWithRetry(async (_client, _model, messages) => {
      const context = JSON.parse(messages[1].content);
      assert.equal(context.source, "paper");
      return { response: { choices: [{ message: { content: JSON.stringify({ ...context.current, minOrganic: 66 }) } }] } };
    });
    assert.equal((await updateRules()).source, "paper");
    assert.equal(getActiveRules().minOrganic, 66);
    assert.equal(getRuleHistory()[0].source, "paper");
    assert.equal(getActiveRules("live").minOrganic, 60, "paper activation cannot change live rules");
    process.env.DRY_RUN = "false";
    db.prepare("DELETE FROM rule_updates WHERE source = 'live'").run();
    _setCallWithRetry(async (_client, _model, messages) => {
      const context = JSON.parse(messages[1].content);
      assert.equal(context.source, "live");
      assert.equal(context.paperTraining.length, 40, "saved paper learning becomes labelled live proposal context");
      assert.ok(context.paperTraining.every(r => r.source === "paper"));
      assert.ok(context.training.every(r => r.source === "live"));
      return { response: { choices: [{ message: { content: JSON.stringify({ ...context.current, minOrganic: 66 }) } }] } };
    });
    assert.equal((await updateRules()).activated, true);
    assert.equal(getActiveRules("live").minOrganic, 66);
  } finally {
    if (previousDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDryRun;
  }
});


test("legacy prose instruction cannot override a deterministic exit", async () => {
  const { computeManagementActions } = await import("../src/core/management/rule-engine.js");
  const { config } = await import("../src/config.js");
  const p = { position: "pos", instruction: "hold forever", pnl_pct: -60, total_value_usd: 10 };
  const action = computeManagementActions([p], new Map(), config, () => ({ prev_pnl_pct: -10, amount_sol: 1, volatility: 3 }));
  assert.equal(action.get("pos").action, "CLOSE");
});
