import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queuedTask, diagnostic, startDiagnostics, stopDiagnostics, sampleDiagnostics } from "../src/core/diagnostics.js";

test("diagnostics trace overlap, failure, bounded retention, rotation and cleanup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kairos-diagnostics-"));
  const oldDir = process.env.KAIROS_DIAGNOSTICS_DIR;
  const oldEnabled = process.env.KAIROS_DIAGNOSTICS;
  process.env.KAIROS_DIAGNOSTICS_DIR = dir;
  process.env.KAIROS_DIAGNOSTICS = "true";
  const file = path.join(dir, `diagnostics-${process.pid}.jsonl`);
  const events = () => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const listeners = process.listenerCount("warning");
  try {
    startDiagnostics(); startDiagnostics();
    assert.equal(process.listenerCount("warning"), listeners + 1);
    let release;
    const first = queuedTask("first", () => new Promise(r => { release = r; }))();
    const second = queuedTask("second", async () => queuedTask("child", async () => 42)());
    sampleDiagnostics();
    const sample = events().at(-1);
    assert.equal(sample.tasks.active, 1);
    assert.equal(sample.tasks.queued, 1);
    assert.ok(sample.memory.rss > 0);
    assert.ok(sample.heapLimitBytes > 0);
    const later = performance.now() + 120_001;
    const clock = mock.method(performance, "now", () => later);
    sampleDiagnostics();
    assert.deepEqual(events().filter(e => e.event === "task_stalled").map(e => e.state).sort(), ["active", "queued"]);
    clock.mock.restore();
    release(); await first;
    assert.equal(await second(), 42);
    await assert.rejects(queuedTask("failure", async () => { throw new Error("SECRET"); })(), /SECRET/);
    const child = events().find(e => e.event === "task_queued" && e.source === "child");
    const parent = events().find(e => e.event === "task_queued" && e.source === "second");
    assert.equal(child.parentTaskId, parent.taskId);
    assert.ok(!fs.readFileSync(file, "utf8").includes("SECRET"));
    const backlog = Array.from({ length: 300 }, () => queuedTask("backlog", async () => {}));
    sampleDiagnostics();
    assert.equal(events().at(-1).trackedTasks, 256);
    assert.equal(events().at(-1).untrackedTasks, 44);
    for (const run of backlog) await run();
    sampleDiagnostics();
    assert.equal(events().at(-1).trackedTasks, 0);
    assert.equal(events().at(-1).tasks.active, 0);
    assert.equal(events().at(-1).tasks.queued, 0);
    // Rotation is byte-bounded even across multiple rotations.
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(file, "x".repeat(5_000_000));
      diagnostic("rotate_check");
    }
    assert.equal(fs.readdirSync(dir).length, 3);
    stopDiagnostics(); stopDiagnostics();
    assert.equal(process.listenerCount("warning"), listeners);
    const size = fs.statSync(file).size;
    process.env.KAIROS_DIAGNOSTICS = "false";
    assert.equal(await queuedTask("disabled", async () => 7)(), 7);
    diagnostic("disabled");
    assert.equal(fs.statSync(file).size, size);
  } finally {
    mock.restoreAll();
    stopDiagnostics();
    if (oldDir === undefined) delete process.env.KAIROS_DIAGNOSTICS_DIR;
    else process.env.KAIROS_DIAGNOSTICS_DIR = oldDir;
    if (oldEnabled === undefined) delete process.env.KAIROS_DIAGNOSTICS;
    else process.env.KAIROS_DIAGNOSTICS = oldEnabled;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
