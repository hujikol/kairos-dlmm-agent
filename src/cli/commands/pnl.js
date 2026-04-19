import { out, die } from "../utils.js";
import { getTrackedPosition } from "../../core/state/index.js";
import { getPositionPnl, getMyPositions } from "../../integrations/meteora.js";

export async function pnlCmd(argv, flags) {
  const posAddr = argv.find((a, i) => !a.startsWith("-") && i > 0 && argv[i - 1] !== "--position" && a !== "pnl");
  const positionAddress = flags.position || posAddr;
  if (!positionAddress) die("Usage: kairos pnl <position_address>");

  let poolAddress;
  const tracked = getTrackedPosition(positionAddress);
  if (tracked?.pool) {
    poolAddress = tracked.pool;
  } else {
    // Fall back: scan positions to find pool
    const pos = await getMyPositions({ force: true });
    const found = pos.positions?.find(p => p.position === positionAddress);
    if (!found) die("Position not found", { position: positionAddress });
    poolAddress = found.pool;
  }

  const pnl = await getPositionPnl({ pool_address: poolAddress, position_address: positionAddress });
  if (tracked?.strategy) pnl.strategy = tracked.strategy;
  if (tracked?.instruction) pnl.instruction = tracked.instruction;
  out(pnl);
}
