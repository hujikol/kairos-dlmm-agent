import { startCronJobs } from "../../core/scheduler.js";

export async function startCmd(argv, flags, sub2, silent) {
  process.stderr.write("[kairos] Starting autonomous agent...\n");
  startCronJobs();
}
