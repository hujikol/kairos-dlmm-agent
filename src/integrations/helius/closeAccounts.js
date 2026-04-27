/**
 * Find and close empty token accounts to reclaim SOL rent.
 * Only closes accounts that are confirmed empty (drained via swap-all or zap-out).
 */

import { PublicKey } from "@solana/web3.js";
import { getWallet, getConnection } from "../meteora/pool.js";
import { config, isDryRun } from "../../config.js";
import { log } from "../../core/logger.js";

const WRAPPED_SOL_MINT = "So11111111112nRaJzAbqGbVeJWuYu4Gy7LEK5gdfRXe";

/**
 * Find all token accounts owned by wallet with balance === 0.
 * Excludes wSOL wrapped SOL account.
 * @param {string} walletAddress
 * @returns {Promise<Array>} Array of { pubkey, mint, rent }
 */
export async function findEmptyTokenAccounts(walletAddress) {
  const connection = getConnection();
  const pubkey = new PublicKey(walletAddress);

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey("TokenkegQfeYyi4xi3DR6rB3rr6MWoYGYWcD5FDfV3DLG"),
    });

    return tokenAccounts.value
      .filter(({ account }) => {
        const info = account.data.parsed?.info;
        if (!info) return false;
        const mint = info.mint;
        const amount = info.tokenAmount?.uiAmount ?? info.amount / Math.pow(10, info.tokenAmount?.decimals ?? 9);
        // Exclude wSOL and accounts with balance
        return mint !== WRAPPED_SOL_MINT && amount === 0;
      })
      .map(({ pubkey, account }) => {
        const info = account.data.parsed.info;
        return {
          pubkey: pubkey.toString(),
          mint: info.mint,
          rent: account.lamports / 1e9,
        };
      });
  } catch (e) {
    log("warn", "closeAccounts", `findEmptyTokenAccounts failed: ${e.message}`);
    return [];
  }
}

/**
 * Get total claimable rent across all empty token accounts.
 * @returns {Promise<{ count, totalRent, accounts }>}
 */
export async function getClaimableRent() {
  const wallet = getWallet();
  const accounts = await findEmptyTokenAccounts(wallet.publicKey.toString());
  const totalRent = accounts.reduce((sum, a) => sum + a.rent, 0);
  return { count: accounts.length, totalRent, accounts };
}

/**
 * Close empty token accounts. Only closes accounts where balance is still 0.
 * @param {Object} opts
 * @param {boolean} opts.dryRun - If true, list accounts without closing
 * @param {number} opts.minRentSol - Minimum SOL rent to close (default from config)
 * @returns {Promise<{ success, closed, failed, totalRecovered }>}
 */
export async function closeEmptyAccounts({ dryRun = false, minRentSol = null } = {}) {
  if (isDryRun()) {
    return { dry_run: true, message: "DRY RUN — no accounts closed" };
  }

  const minRent = minRentSol ?? config.management.autoClaimMinRentSol ?? 0.001;
  const wallet = getWallet();
  const walletPubkey = wallet.publicKey;

  // Find accounts
  const allEmpty = await findEmptyTokenAccounts(walletPubkey.toString());
  const eligible = allEmpty.filter(a => a.rent >= minRent);

  if (eligible.length === 0) {
    return { success: true, closed: 0, failed: 0, totalRecovered: 0, message: "No eligible accounts" };
  }

  const MAX_PER_TX = config.management.autoClaimMaxAccountsPerTx ?? 20;
  const toClose = eligible.slice(0, MAX_PER_TX);

  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      closed: 0,
      would_close: toClose.length,
      totalRent: toClose.reduce((s, a) => s + a.rent, 0),
      accounts: toClose,
    };
  }

  // Build batched transaction
  const connection = getConnection();
  const { Transaction, TransactionInstruction } = await import("@solana/web3.js");

  const tx = new Transaction();
  const tokenProgram = new PublicKey("TokenkegQfeYyi4xi3DR6rB3rr6MWoYGYWcD5FDfV3DLG");

  let closed = 0;
  let failed = 0;
  let totalRecovered = 0;

  for (const acct of toClose) {
    try {
      // Re-verify balance before closing (race guard)
      const acctInfo = await connection.getParsedAccountInfo(new PublicKey(acct.pubkey));
      const info = acctInfo.value?.data?.parsed?.info;
      if (!info) { failed++; continue; }
      const currentBalance = info.tokenAmount?.uiAmount ?? 0;
      if (currentBalance > 0) {
        log("debug", "closeAccounts", `${acct.pubkey} now has balance ${currentBalance} — skipping`);
        failed++;
        continue;
      }

      const closeIx = new TransactionInstruction({
        keys: [
          { pubkey: new PublicKey(acct.pubkey), isSigner: false, isWritable: true },
          { pubkey: walletPubkey, isSigner: true, isWritable: true },
          { pubkey: walletPubkey, isSigner: false, isWritable: false }, // destination
        ],
        programId: tokenProgram,
        data: Buffer.from([0x07]), // closeAccount instruction
      });

      tx.add(closeIx);
      closed++;
      totalRecovered += acct.rent;
    } catch (e) {
      log("warn", "closeAccounts", `Failed to prepare close for ${acct.pubkey}: ${e.message}`);
      failed++;
    }
  }

  if (tx.instructions.length === 0) {
    return { success: true, closed: 0, failed, totalRecovered: 0, message: "No accounts to close" };
  }

  try {
    tx.feePayer = walletPubkey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(...wallet.secretKey ? [wallet] : []);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    log("info", "closeAccounts", `Closed ${closed} accounts, recovered ~${totalRecovered.toFixed(4)} SOL (tx: ${sig})`);
    return { success: true, closed, failed, totalRecovered, tx: sig };
  } catch (e) {
    log("error", "closeAccounts", `Close accounts tx failed: ${e.message}`);
    return { success: false, closed, failed, totalRecovered, error: e.message };
  }
}

/**
 * Orchestrator — called by autoSwapRewardFees after confirmed drain success.
 * @param {Object} opts
 */
export async function autoClaimSolAccounts(opts = {}) {
  const enabled = config.management.autoClaimSolAccounts ?? false;
  if (!enabled) return { success: true, skipped: "disabled" };
  return await closeEmptyAccounts(opts);
}
