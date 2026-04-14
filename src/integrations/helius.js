//Backward-compatible re-export — all public APIs from the old helius.js
//Now split across src/integrations/helius/{normalize,balances,swaps,auto,index}.js
//Existing callers (helius.js import path) continue to work without changes.
export * from "./helius/index.js";