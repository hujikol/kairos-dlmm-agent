import { out } from "../utils.js";
import { getWalletBalances } from "../../integrations/helius.js";

export async function balanceCmd(argv, flags) {
  out(await getWalletBalances({}));
}
