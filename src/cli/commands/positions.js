import { out } from "../utils.js";
import { getMyPositions } from "../../integrations/meteora.js";

export async function positionsCmd(_argv, _flags) {
  out(await getMyPositions({ force: true }));
}
