import { out, die } from "../utils.js";
import { executeTool } from "../../tools/executor.js";

export async function deployCmd(argv, flags) {
  if (!flags.pool) die("Usage: kairos deploy --pool <addr> --amount <sol>");
  const amountX = flags["amount-x"] ? parseFloat(flags["amount-x"]) : undefined;
  if (!flags.amount && !amountX) die("--amount or --amount-x is required");

  out(await executeTool("deploy_position", {
    pool_address: flags.pool,
    amount_y: flags.amount ? parseFloat(flags.amount) : undefined,
    amount_x: amountX,
    strategy: flags.strategy,
    single_sided_x: argv.includes("--single-sided-x"),
    bins_below: flags["bins-below"] ? parseInt(flags["bins-below"]) : undefined,
    bins_above: flags["bins-above"] ? parseInt(flags["bins-above"]) : undefined,
    allow_duplicate_pool: argv.includes("--allow-duplicate-pool"),
  }));
}
