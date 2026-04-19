import { out, die } from "../utils.js";
import { executeTool } from "../../tools/executor.js";

export async function claimCmd(argv, flags) {
  if (!flags.position) die("Usage: kairos claim --position <addr>");
  out(await executeTool("claim_fees", { position_address: flags.position }));
}
