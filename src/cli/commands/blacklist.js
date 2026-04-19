import { out, die } from "../utils.js";
import { addToBlacklist, listBlacklist } from "../../features/token-blacklist.js";

export async function blacklistCmd(argv, flags, sub2) {
  if (sub2 === "add") {
    if (!flags.mint) die("Usage: kairos blacklist add --mint <addr> --reason <text>");
    if (!flags.reason) die("--reason is required");
    out(addToBlacklist({ mint: flags.mint, reason: flags.reason }));
  } else if (sub2 === "list" || !sub2) {
    out(listBlacklist());
  } else {
    die(`Unknown blacklist subcommand: ${sub2}. Use: add, list`);
  }
}
