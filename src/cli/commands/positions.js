import { out } from "../utils.js";
import { getMyPositions } from "../../integrations/meteora.js";

export async function positionsCmd(argv, flags) {
  out(await getMyPositions({ force: true }));
}
