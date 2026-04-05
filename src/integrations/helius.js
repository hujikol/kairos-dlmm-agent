import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { getConnection as getRpcConnection } from "./solana.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _wallet = null;

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

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";
const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("error", "wallet", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
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
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("error", "wallet", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Get the direct real-time balance of a specific mint using the Solana connection.
 * Faster and more accurate than waiting for the Helius Wallet API to index.
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
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
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
 * Automatically swaps non-SOL tokens (reward fees or closed position principal) to SOL.
 * If mints are provided, only those are checked. Otherwise, all non-SOL tokens with USD >= 0.10 are swapped.
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
            // We don't have the USD value here, but if it's a known mint from close_position, we swap it.
            tokensToSwap.push({ mint, balance: bal, symbol: mint.slice(0, 8), usd: 1.0 }); // Dummy USD > 0.10
          } else {
            log("info", "wallet", `Skipped ${mint.slice(0, 8)}: Direct balance is 0.`);
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
      log("info", "wallet", `Auto-swapping token ${token.symbol || token.mint.slice(0, 8)} (${token.balance}) to SOL`);
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
