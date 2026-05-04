import { out } from "../utils.js";
import { getWalletBalances } from "../../integrations/helius.js";

export async function balanceCmd(_argv, _flags) {
  out(await getWalletBalances({}));
}
