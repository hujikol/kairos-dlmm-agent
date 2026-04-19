import { out, die } from "../utils.js";
import { getActiveBin } from "../../integrations/meteora.js";

export async function activeBinCmd(argv, flags) {
  if (!flags.pool) die("Usage: kairos active-bin --pool <addr>");
  out(await getActiveBin({ pool_address: flags.pool }));
}
