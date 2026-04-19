import { out, die, COMMAND_DEFAULTS } from "../utils.js";
import { searchPools } from "../../integrations/meteora.js";

export async function searchPoolsCmd(argv, flags) {
  const query = flags.query || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "search-pools");
  if (!query) die("Usage: kairos search-pools --query <name_or_symbol>");
  const limit = flags.limit ? parseInt(flags.limit) : COMMAND_DEFAULTS.SEARCH_POOLS_LIMIT;
  out(await searchPools({ query, limit }));
}
