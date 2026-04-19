import { out, die } from "../utils.js";
import { config } from "../../config.js";
import { executeTool } from "../../tools/executor.js";

export async function configCmd(argv, flags, sub2) {
  if (sub2 === "get" || !sub2) {
    out(config);
  } else if (sub2 === "set") {
    const key = argv.filter(a => !a.startsWith("-"))[2];
    const rawVal = argv.filter(a => !a.startsWith("-"))[3];
    if (!key || rawVal === undefined) die("Usage: kairos config set <key> <value>");
    let value = rawVal;
    try { value = JSON.parse(rawVal); } catch { /* keep as string */ }
    out(await executeTool("update_config", { changes: { [key]: value }, reason: "CLI config set" }));
  } else {
    die(`Unknown config subcommand: ${sub2}. Use: get, set`);
  }
}
