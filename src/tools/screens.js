import { discoverPools, getPoolDetail, getTopCandidates } from "../screening/discovery.js";
import { searchPools, getActiveBin } from "../integrations/meteora.js";

export function registerScreens(registerTool) {
  registerTool("discover_pools", discoverPools);
  registerTool("get_top_candidates", getTopCandidates);
  registerTool("get_pool_detail", getPoolDetail);
  registerTool("search_pools", searchPools);
  registerTool("get_active_bin", getActiveBin);
}
