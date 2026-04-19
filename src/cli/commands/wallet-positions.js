import { out, die } from "../utils.js";
import { getWalletPositions } from "../../integrations/meteora.js";

export async function walletPositionsCmd(argv, flags) {
  const wallet = flags.wallet || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "wallet-positions");
  if (!wallet) die("Usage: kairos wallet-positions --wallet <addr>");
  out(await getWalletPositions({ wallet_address: wallet }));
}
