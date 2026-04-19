import { out, die } from "../utils.js";
import { getTokenNarrative } from "../../integrations/jupiter.js";

export async function tokenNarrativeCmd(argv, flags) {
  const mint = flags.mint || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "token-narrative");
  if (!mint) die("Usage: kairos token-narrative --mint <addr>");
  out(await getTokenNarrative({ mint }));
}
