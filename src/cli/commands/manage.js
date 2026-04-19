import { out } from "../utils.js";
import { runManagementCycle } from "../../core/cycles.js";

export async function manageCmd(argv, flags, sub2, silent) {
  const report = await runManagementCycle({ silent });
  out({ done: true, report: report || "No action taken" });
}
