// Side-effect module: sets up test environment variables BEFORE any other imports.
// Import this FIRST in any test file that touches config-dependent modules.
// Does not export anything — pure side effect.
process.env.WALLET_PRIVATE_KEY ??= "[]";
process.env.RPC_URL ??= "https://api.mainnet-beta.solana.com";
process.env.OPENROUTER_API_KEY ??= "test-key";