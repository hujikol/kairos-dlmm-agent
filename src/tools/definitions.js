import { SCREEN_TOOLS } from './screen-tools.js';
import { POSITION_TOOLS } from './position-tools.js';
import { WALLET_TOOLS } from './wallet-tools.js';
import { ADMIN_TOOLS } from './admin-tools.js';
import { CACHE_TOOLS } from './cache-tools.js';
import { SMART_TOOLS } from './smart-tools.js';

export const ALL_TOOLS = [
  ...SCREEN_TOOLS,
  ...POSITION_TOOLS,
  ...WALLET_TOOLS,
  ...ADMIN_TOOLS,
  ...CACHE_TOOLS,
  ...SMART_TOOLS,
];

// Name → parameter schema lookup (used by executor for runtime validation)
export const TOOL_DEFINITIONS = {};
for (const tool of ALL_TOOLS) {
  TOOL_DEFINITIONS[tool.function.name] = tool.function.parameters;
}
