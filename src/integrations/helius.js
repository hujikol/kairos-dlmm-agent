import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { addrShort } from "../tools/addrShort.js";
import { getConnection as getRpcConnection } from "./solana.js";
import bs58 from "bs58";
import { log } from "../core/logger.js";
import { config } from "../config.js";
import { SOL_MINT } from "../constants.js";

let _wallet = null;

// ─── 5-minute TTL cache for getWalletBalances() ─────────────────
let _balanceCache = null;
export const CACHE_TTL = parseInt(process.env.HELIUS_BALANCE_CACHE_TTL_MS || "300000"); // 5 minutes

export function invalidateBalanceCache() {
  _balanceCache = null;
}

/**
 * Returns age of cached balance in ms, or null if cache is empty/expired.
 */
export function getBalanceCacheAgeMs() {
  if (!_balanceCache) return null;
  const age = Date.now() - _balanceCache.timestamp;
  if (age >= CACHE_TTL) return null; // expired
  return age;
}

/**
 * Returns the cached balance object directly, or null if cache is empty/expired.
 */
export function getCachedBalance() {
  return getBalanceCacheAgeMs() !== null ? _balanceCache.data : null;
}

function getConnection() {
  return getRpcConnection("confirmed");
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = process.env.JUPITER_PRICE_API_URL || "https://api.jup.ag/price/v3";
const JUPITER_ULTRA_API = process.env.JUPITER_ULTRA_API_URL || "https://api.jup.ag/ultra/v1";
const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API_URL || "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  // ─── Check cache first ──────────────────────────────────────
  if (_balanceCache && Date.now() - _balanceCache.timestamp < CACHE_TTL) {
    log("info", "wallet", "Using cached balance (age: " + Math.round((Date.now() - _balanceCache.timestamp) / 1000) + "s)");
    return _balanceCache.data;
  }

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch (e) { log("warn", "helius", `Failed to get wallet balances: ${e?.message}`); const errResult = { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
    _balanceCache = { data: errResult, timestamp: Date.now() };
    return errResult;
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;

  // ─── Try Helius first ────────────────────────────────────────
  if (!HELIUS_KEY) {
    log("warn", "wallet", "HELIUS_API_KEY not set — falling back to RPC balance check");
    const rpcResult = await getBalancesViaRpc(walletAddress);
    _balanceCache = { data: rpcResult, timestamp: Date.now() };
    return rpcResult;
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || addrShort(b.mint),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    const result = {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
    _balanceCache = { data: result, timestamp: Date.now() };
    return result;
  } catch (error) {
    log("warn", "wallet", `Helius error, falling back to RPC: ${error.message}`);
    const rpcResult = await getBalancesViaRpc(walletAddress);
    _balanceCache = { data: rpcResult, timestamp: Date.now() };
    return rpcResult;
  }
}

/**
 * Fallback balance check using direct Solana RPC — no external API needed.
 * Returns SOL balance accurately even without Helius.
 */
async function getBalancesViaRpc(walletAddress) {
  try {
    const connection = getConnection();
    const lamports = await connection.getBalance(new PublicKey(walletAddress));
    const solBalance = lamports / LAMPORTS_PER_SOL;

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: null,
    };
  } catch (e) {
    log("error", "wallet", `RPC balance fallback failed: ${e.message}`);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: e.message,
    };
  }
}

/**
 * Get the direct real-time balance of a specific SPL mint via Solana RPC.
 * Falls back to 0 on error. Does not use the balance cache.
 * @param {string} mint - Mint address (use "SOL" or wrapped-SOL mint for native SOL)
 * @returns {Promise<number>} Token balance (SOL-denominated for native SOL)
 */
export async function getMintBalance(mint) {
  const connection = getConnection();
  const wallet = getWallet();
  const mintPubKey = new PublicKey(normalizeMint(mint));

  if (mintPubKey.toString() === config.tokens.SOL) {
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPubKey });
    if (!accounts.value || accounts.value.length === 0) return 0;
    
    return accounts.value.reduce((sum, acc) => {
      return sum + (acc.account.data.parsed.info.tokenAmount.uiAmount || 0);
    }, 0);
  } catch (e) {
    log("error", "wallet", `Failed to fetch balance for ${mint}: ${e.message}`);
    return 0;
  }
}

/**
 * Swap tokens via Jupiter Ultra API (order → sign → execute).
 * Falls back to the standard Jupiter quote API if Ultra is unavailable.
 * Respects DRY_RUN env var — returns early without sending transactions.
 * @param {Object} opts - Swap parameters
 * @param {string} opts.input_mint - Source mint address
 * @param {string} opts.output_mint - Destination mint address
 * @param {number} opts.amount - Amount to swap (in token units, not lamports)
 * @returns {Promise<Object>} { success, tx, input_mint, output_mint, amount_in, amount_out } or { success: false, error }
 */
// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" ||
    mint === "native" ||
    /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (input_mint === output_mint) {
    log("info", "swap", `Skipping swap: input and output mints are the same (${input_mint})`);
    return { success: true, message: "Input and output mints are the same — skipped." };
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("info", "swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Ultra order (unsigned tx + requestId) ─────────────
    const orderUrl =
      `${JUPITER_ULTRA_API}/order` +
      `?inputMint=${input_mint}` +
      `&outputMint=${output_mint}` +
      `&amount=${amountStr}` +
      `&taker=${wallet.publicKey.toString()}`;

    const orderRes = await fetch(orderUrl, {
      headers: { "x-api-key": JUPITER_API_KEY },
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      if (orderRes.status === 500) {
        log("info", "swap", `Ultra failed for ${input_mint}, falling back to regular swap API`);
        return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr });
      }
      throw new Error(`Ultra order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      log("info", "swap", `Ultra error for ${input_mint}, falling back to regular swap API`);
      return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr });
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_ULTRA_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JUPITER_API_KEY,
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Ultra execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("info", "swap", `SUCCESS tx: ${result.signature}`);

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
    };
  } catch (error) {
    log("error", "swap", error.message);
    return { success: false, error: error.message };
  }
}

async function swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr }) {
  // ─── Get quote ─────────────────────────────────────────────
  const quoteRes = await fetch(
    `${JUPITER_QUOTE_API}/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}&slippageBps=300`,
    { headers: { "x-api-key": JUPITER_API_KEY } }
  );
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote error: ${quote.error}`);

  // ─── Get swap tx ───────────────────────────────────────────
  const swapRes = await fetch(`${JUPITER_QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": JUPITER_API_KEY },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap tx failed: ${swapRes.status} ${await swapRes.text()}`);
  const { swapTransaction } = await swapRes.json();

  // ─── Sign and send ─────────────────────────────────────────
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(txHash, "confirmed");

  log("info", "swap", `SUCCESS (fallback) tx: ${txHash}`);
  return { success: true, tx: txHash, input_mint, output_mint };
}

/**
 * Automatically swap non-SOL tokens (fees or closed principal) to SOL.
 * If mints are provided, only those are checked. Otherwise all non-SOL tokens
 * with USD value >= $0.10 are swapped via Jupiter.
 * @param {string[]|null} [mints=null] - Specific mints to swap, or null to auto-detect
 * @returns {Promise<Object>} { success, swapped: [{ success, tx, ... }, ...] } or { success: false, error }
 */
export async function autoSwapRewardFees(mints = null) {
  try {
    const balances = await getWalletBalances();
    const solMint = normalizeMint(config.tokens.SOL);

    let tokensToSwap = balances.tokens?.filter(t => 
      normalizeMint(t.mint) !== solMint && 
      (mints === null || mints.includes(t.mint)) && 
      t.usd >= 0.10
    );

    // ─── Direct Fallback for provided mints (Helius lag) ───────
    if (mints && mints.length > 0) {
      const foundMints = new Set(tokensToSwap.map(t => t.mint));
      const missingMints = mints.filter(m => !foundMints.has(m) && m !== config.tokens.SOL);
      
      if (missingMints.length > 0) {
        log("info", "wallet", `Checking direct balance for ${missingMints.length} missing mint(s) due to Helius API lag...`);
        for (const mint of missingMints) {
          const bal = await getMintBalance(mint);
          if (bal > 0) {
            // usd=1.0 is a Helius placeholder — only set when balance > 0 (skip dust/zero-value tokens)
            tokensToSwap.push({ mint, balance: bal, symbol: addrShort(mint), usd: bal > 0 ? 1.0 : 0 });
          } else {
            log("info", "wallet", `Skipped ${addrShort(mint)}: Direct balance is 0.`);
          }
        }
      }
    }

    if (!tokensToSwap || tokensToSwap.length === 0) {
      log("info", "wallet", "No tokens found to auto-swap.");
      return { success: true, swapped: [] };
    }

    const swapResults = [];
    for (const token of tokensToSwap) {
      log("info", "wallet", `Auto-swapping token ${token.symbol || token.addrShort(mint)} (${token.balance}) to SOL`);
      const result = await swapToken({ 
        input_mint: token.mint, 
        output_mint: config.tokens.SOL, 
        amount: token.balance 
      });
      swapResults.push(result);
    }
    return { success: true, swapped: swapResults };
  } catch (e) {
    log("error", "wallet", `Auto-swap failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Sweeps all tokens in the wallet back to SOL (manual command).
 */
export async function swapAllTokensToSol() {
  log("info", "wallet", "Manual 'Swap All' triggered — sweeping wallet to SOL...");
  return await autoSwapRewardFees(null);
}
