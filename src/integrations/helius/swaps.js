import { VersionedTransaction, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../../core/logger.js";
import { config, isDryRun } from "../../config.js";
import { normalizeMint } from "./normalize.js";
import { getConnection } from "../solana.js";

// ─── Magic numbers / API defaults ────────────────────────────────
export const JUPITER_DATAPI_BASE_URL = process.env.JUPITER_DATAPI_BASE_URL || "https://api.jup.ag/price/v3";
export const JUPITER_ULTRA_API        = process.env.JUPITER_ULTRA_API_URL || "https://api.jup.ag/ultra/v1";
export const JUPITER_QUOTE_API        = process.env.JUPITER_QUOTE_API_URL || "https://api.jup.ag/swap/v1";
export const JUPITER_API_KEY          = process.env.JUPITER_API_KEY;

const SLIPPAGE_BPS = config.screening?.slippageBps ?? 300; // 3%

// ─── Wallet lazy init (shared with balances.js) ────────────────
let _wallet = null;

export function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

async function getDecimals(mint) {
  const connection = getConnection();
  const normalized = normalizeMint(mint);
  if (normalized === normalizeMint(config.tokens.SOL)) return 9;
  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(normalized));
    return mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
  } catch { return 9; }
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
export async function swapToken({ input_mint, output_mint, amount }) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (input_mint === output_mint) {
    log("info", "swap", `Skipping swap: input and output mints are the same (${input_mint})`);
    return { success: true, message: "Input and output mints are the same — skipped." };
  }

  if (isDryRun()) {
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
    `${JUPITER_QUOTE_API}/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}&slippageBps=${SLIPPAGE_BPS}`,
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
  const inDecimals = await getDecimals(input_mint);
  const outDecimals = await getDecimals(output_mint);
  return {
    success: true,
    tx: txHash,
    input_mint,
    output_mint,
    amount_in: parseFloat(quote.inAmount) / Math.pow(10, inDecimals),
    amount_out: parseFloat(quote.outAmount) / Math.pow(10, outDecimals),
  };
}