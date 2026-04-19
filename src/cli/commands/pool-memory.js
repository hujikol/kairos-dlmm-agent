import { out, die } from "../utils.js";
import { getPoolMemory } from "../../features/pool-memory.js";

export async function poolMemoryCmd(argv, flags) {
  if (!flags.pool) die("Usage: kairos pool-memory --pool <addr>");
  out(getPoolMemory({ pool_address: flags.pool }));
}
