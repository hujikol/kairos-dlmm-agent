import { getTokenInfo, getTokenHolders, getTokenNarrative } from "../integrations/jupiter.js";
import {
  addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool,
} from "../features/smart-wallets.js";

export function registerTokens(registerTool) {
  registerTool("get_token_info", getTokenInfo);
  registerTool("get_token_holders", getTokenHolders);
  registerTool("get_token_narrative", getTokenNarrative);
  registerTool("add_smart_wallet", addSmartWallet);
  registerTool("remove_smart_wallet", removeSmartWallet);
  registerTool("list_smart_wallets", listSmartWallets);
  registerTool("check_smart_wallets_on_pool", checkSmartWalletsOnPool);
}
