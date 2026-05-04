import { startCronJobs } from "../../core/scheduler.js";

export async function startCmd(_argv, _flags, _sub2, _silent) {
  process.stderr.write("[kairos] Starting autonomous agent...\n");
  startCronJobs();
}
