// Metadata only: never pass prompts, tool arguments/results, credentials, or URLs.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

const context = new AsyncLocalStorage();
const pending = new Map();
const counts = { queued: 0, active: 0, completed: 0, failed: 0 };
const runId = randomUUID();
const enabled = () => process.env.KAIROS_DIAGNOSTICS !== "false";
let timer, delay, observer, lastMemory, lastCpu, lastSample;
let gc = { count: 0, durationMs: 0 };
let writeFailed = false;

export function diagnostic(event, fields = {}) {
  if (!enabled()) return;
  try {
    const dir = process.env.KAIROS_DIAGNOSTICS_DIR || "./logs";
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `diagnostics-${process.pid}.jsonl`);
    // Fixed filenames bound retention across days: current + two 5 MB backups per PID.
    if (fs.existsSync(file) && fs.statSync(file).size >= 5_000_000) {
      fs.rmSync(`${file}.2`, { force: true });
      if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(), runId, pid: process.pid,
      taskId: context.getStore()?.id, ...fields, event,
    }) + "\n", { mode: 0o600 });
  } catch {
    // Diagnostics must not break trading or recursively enqueue notifications.
    if (!writeFailed) console.error("[diagnostics] Cannot write diagnostic log");
    writeFailed = true;
  }
}

// ponytail: retain 256 task records; use external tracing if larger backlogs need individual inspection.
export function queuedTask(source, fn) {
  if (!enabled()) return fn;
  const task = { id: randomUUID(), parentTaskId: context.getStore()?.id,
    source, state: "queued", queuedAt: performance.now(), lastProgress: performance.now() };
  counts.queued++;
  if (pending.size < 256) pending.set(task.id, task);
  diagnostic("task_queued", { taskId: task.id, parentTaskId: task.parentTaskId, source, ...counts });
  return async (...args) => {
    if (task.state !== "queued") {
      diagnostic("duplicate_task_start", { taskId: task.id, source });
      // Observe without changing execution semantics.
      return fn(...args);
    }
    counts.queued--;
    counts.active++;
    task.state = "active";
    task.startedAt = task.lastProgress = performance.now();
    return context.run(task, async () => {
      diagnostic("task_started", { source, waitMs: task.startedAt - task.queuedAt, ...counts });
      try {
        const result = await fn(...args);
        counts.completed++;
        diagnostic("task_completed", { source, durationMs: performance.now() - task.startedAt });
        return result;
      } catch (error) {
        counts.failed++;
        diagnostic("task_failed", { source, durationMs: performance.now() - task.startedAt,
          errorName: error?.name, status: typeof error?.status === "number" ? error.status : undefined });
        throw error;
      } finally {
        counts.active--;
        task.state = "finished";
        pending.delete(task.id);
      }
    });
  };
}

export function progress(event, fields = {}) {
  const task = context.getStore();
  if (task) task.lastProgress = performance.now();
  diagnostic(event, fields);
}

export function sampleDiagnostics() {
  const now = performance.now();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const resources = {};
  for (const type of process.getActiveResourcesInfo()) resources[type] = (resources[type] || 0) + 1;
  diagnostic("runtime_sample", {
    uptimeSec: process.uptime(), memory,
    memoryDelta: lastMemory ? Object.fromEntries(Object.keys(memory).map(k => [k, memory[k] - lastMemory[k]])) : null,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    cpuPercent: lastCpu ? 100 * ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / ((now - lastSample) * 1000) : null,
    eventLoopP99Ms: delay ? delay.percentile(99) / 1e6 : null,
    eventLoopMaxMs: delay ? delay.max / 1e6 : null,
    gc, resources, tasks: { ...counts }, trackedTasks: pending.size,
    untrackedTasks: counts.active + counts.queued - pending.size,
  });
  for (const task of pending.values()) {
    if (now - task.lastProgress >= 120_000) diagnostic("task_stalled", {
      taskId: task.id, parentTaskId: task.parentTaskId, source: task.source, state: task.state,
      ageMs: now - task.queuedAt, noProgressMs: now - task.lastProgress,
    });
  }
  lastMemory = memory; lastCpu = cpu; lastSample = now;
  gc = { count: 0, durationMs: 0 };
  delay?.reset();
}

function onWarning(warning) { diagnostic("process_warning", { name: warning.name }); }
function onFatal(error, origin) { diagnostic("uncaught_exception", { errorName: error?.name, origin }); }
function onExit(code) { diagnostic("process_exit", { code, ...counts }); }

export function startDiagnostics() {
  if (timer || !enabled()) return;
  delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { gc.count++; gc.durationMs += entry.duration; }
  });
  observer.observe({ entryTypes: ["gc"] });
  process.on("warning", onWarning);
  process.on("uncaughtExceptionMonitor", onFatal);
  process.on("exit", onExit);
  diagnostic("diagnostics_started", { node: process.version, platform: process.platform });
  sampleDiagnostics();
  timer = setInterval(sampleDiagnostics, 30_000);
  timer.unref();
}

export function stopDiagnostics() {
  if (!timer) return;
  sampleDiagnostics();
  diagnostic("diagnostics_stopped", { ...counts });
  clearInterval(timer); timer = null;
  delay.disable(); observer.disconnect();
  process.off("warning", onWarning);
  process.off("uncaughtExceptionMonitor", onFatal);
  process.off("exit", onExit);
}
