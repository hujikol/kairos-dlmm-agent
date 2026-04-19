import { out, die, COMMAND_DEFAULTS } from "../utils.js";
import { getTokenHolders } from "../../integrations/jupiter.js";

export async function tokenHoldersCmd(argv, flags) {
  const mint = flags.mint || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "token-holders");
  if (!mint) die("Usage: kairos token-holders --mint <addr>");
  const limit = flags.limit ? parseInt(flags.limit) : COMMAND_DEFAULTS.TOKEN_HOLDERS_LIMIT;
  out(await getTokenHolders({ mint, limit }));
}
