// Run with Node 24: node scripts/paper-soak.js [duration-seconds]. Always isolates paper money and credentials.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const duration = Number(process.argv[2] ?? 300);
if (!Number.isFinite(duration) || duration < 60 || duration > 3600) throw new Error("Duration must be 60–3600 seconds");
const dir = path.join(root, "logs", `paper-soak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(dir, { recursive: true });
const env = fs.existsSync(path.join(root, ".env")) ? dotenv.parse(fs.readFileSync(path.join(root, ".env"))) : {};
const user = fs.existsSync(path.join(root, "user-config.json")) ? JSON.parse(fs.readFileSync(path.join(root, "user-config.json"))) : {};
const taskEnv = {
  PATH: process.env.PATH, DRY_RUN: "true", DOTENV_CONFIG_PATH: path.join(dir, "no-secrets.env"),
  KAIROS_USER_CONFIG_PATH: path.join(root, "profiles/high-volume-paper.json"), KAIROS_GMGN_CONFIG_PATH: path.join(dir, "no-gmgn.json"),
  KAIROS_DB_PATH: path.join(dir, "paper.db"), KAIROS_DIAGNOSTICS_DIR: dir, KAIROS_DIAGNOSTICS: "true",
  RPC_URL: env.RPC_URL || user.rpcUrl || "https://api.mainnet-beta.solana.com", HEALTH_PORT: "31388", LOG_LEVEL: "warn",
  JUPITER_API_KEY: env.JUPITER_API_KEY || process.env.JUPITER_API_KEY || "",
};
const worker = path.join(dir, "worker.mjs");
const url = rel => new URL(`../${rel}`, import.meta.url).href;
fs.writeFileSync(worker, `
import fs from "node:fs";
await import(${JSON.stringify(url("src/index.js"))});
const { telegramHandler, _telegramBusy, drainTelegramQueue } = await import(${JSON.stringify(url("src/telegram/index.js"))});
const { diagnostic, sampleDiagnostics } = await import(${JSON.stringify(url("src/core/diagnostics.js"))});
const { _busyState } = await import(${JSON.stringify(url("src/core/state/scheduler-state.js"))});
let requested = 0, settled = 0, errors = 0;
const pending = new Set();
const commandTimer = setInterval(() => {
  for (let i = 0; i < 30; i++) {
    requested++;
    const task = telegramHandler(i % 2 ? "/balance" : "/thresholds").catch(() => { errors++; }).finally(() => { settled++; pending.delete(task); });
    pending.add(task);
  }
  diagnostic("soak_commands", { requested, settled, pending: pending.size, activeHandlers: _telegramBusy._count });
}, 15000);
const gcTimer = setInterval(() => { global.gc?.(); sampleDiagnostics(); }, 30000);
setTimeout(async () => {
  clearInterval(commandTimer); clearInterval(gcTimer); drainTelegramQueue();
  await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, 15000))]);
  global.gc?.(); sampleDiagnostics();
  fs.writeFileSync(${JSON.stringify(path.join(dir, "commands.json"))}, JSON.stringify({ requested, settled, errors, pending: pending.size, activeHandlers: _telegramBusy._count, busy: _busyState }));
  process.kill(process.pid, "SIGTERM");
}, ${duration * 1000});
`);
const log = fs.openSync(path.join(dir, "runtime.log"), "w", 0o600);
const child = spawn(process.execPath, ["--expose-gc", worker], { cwd: root, env: taskEnv, stdio: ["ignore", log, log] });
const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const watchdog = setTimeout(() => child.kill("SIGKILL"), (duration + 60) * 1000);
child.once("exit", code => {
  clearTimeout(watchdog); fs.closeSync(log); fs.rmSync(worker);
  console.log(JSON.stringify({ directory: dir, exitCode: code, durationSeconds: duration, realWalletKeyPassed: false, telegramTokenPassed: false }));
  process.exitCode = code ?? 1;
});
console.log(JSON.stringify({ directory: dir, pid: child.pid, durationSeconds: duration, mode: "paper" }));
