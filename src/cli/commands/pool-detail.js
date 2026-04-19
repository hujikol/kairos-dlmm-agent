import { out, die } from "../utils.js";
import { getPoolDetail } from "../../screening/discovery.js";

export async function poolDetailCmd(argv, flags) {
  if (!flags.pool) die("Usage: kairos pool-detail --pool <addr> [--timeframe 5m]");
  out(await getPoolDetail({ pool_address: flags.pool, timeframe: flags.timeframe || "5m" }));
}
