import { out, die } from "../utils.js";
import { executeTool } from "../../tools/executor.js";

export async function swapCmd(argv, flags) {
  if (!flags.from || !flags.to || !flags.amount) die("Usage: kairos swap --from <mint> --to <mint> --amount <n>");
  out(await executeTool("swap_token", {
    input_mint: flags.from,
    output_mint: flags.to,
    amount: parseFloat(flags.amount),
  }));
}
