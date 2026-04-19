import { out, die } from "../utils.js";
import { getTokenInfo } from "../../integrations/jupiter.js";

export async function tokenInfoCmd(argv, flags) {
  const query = flags.query || flags.mint || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "token-info");
  if (!query) die("Usage: kairos token-info --query <mint_or_symbol>");
  out(await getTokenInfo({ query }));
}
