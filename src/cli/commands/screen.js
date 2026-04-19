import { out } from "../utils.js";
import { runScreeningCycle } from "../../core/cycles.js";

export async function screenCmd(argv, flags, sub2, silent) {
  const report = await runScreeningCycle({ silent });
  out({ done: true, report: report || "No action taken" });
}
