import { out, die } from "../utils.js";
import { executeTool } from "../../tools/executor.js";

export async function closeCmd(argv, flags) {
  if (!flags.position) die("Usage: kairos close --position <addr>");
  out(await executeTool("close_position", {
    position_address: flags.position,
    skip_swap: flags["skip-swap"] ?? false,
  }));
}
