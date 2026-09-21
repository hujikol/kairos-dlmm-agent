/**
 * Shared formatters for Telegram and REPL output.
 */

/** Escape a cell for Rich Markdown (pipe + backslash are structural). */
function mdCell(v) {
  return String(v).replace(/[\\|]/g, "\\$&").replace(/\n/g, " ");
}

/**
 * GFM table for Telegram rich messages (rendered natively by clients).
 * @param {string[]} header
 * @param {Array<Array<*>>} rows
 * @param {('l'|'c'|'r')[]} [align] - per-column alignment (left/center/right)
 * @returns {string}
 */
export function mdTable(header, rows, align = []) {
  const edge = (i) =>
    align[i] === "r" ? "---:" : align[i] === "c" ? ":---:" : ":---";
  const body = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`);
  return [
    `| ${header.map(mdCell).join(" | ")} |`,
    `| ${header.map((_, i) => edge(i)).join(" | ")} |`,
    ...body,
  ].join("\n");
}

/**
 * Format candidates as GFM table (Telegram rich) or aligned text (REPL).
 * @param {Array} candidates
 * @param {'terminal'|'telegram'} format
 * @returns {string}
 */
export function formatCandidates(candidates, format = "terminal") {
  if (!candidates.length) return "  No eligible pools found right now.";

  if (format === "telegram") {
    return mdTable(
      ["#", "Pool", "fee/TVL", "Vol", "org"],
      candidates.map((p, i) => [
        i + 1,
        p.name.slice(0, 10),
        `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.slice(0, 5),
        `$${(p.volume_window || 0) / 1000 > 0 ? (p.volume_window / 1000).toFixed(1) : "0.0"}k`,
        String(p.organic_score),
      ]),
      ["l", "l", "r", "r", "r"],
    );
  }

  // terminal format
  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${(p.volume_window || 0) / 1000 > 0 ? (p.volume_window / 1000).toFixed(1) : '0.0'}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });
  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

/**
 * Format wallet balance data.
 * @param {{ sol: number, sol_usd: number, tokens: Array, total_usd: number }} data
 * @param {'terminal'|'telegram'} format
 * @returns {string}
 */
export function formatBalance(data, format = "terminal") {
  const { sol, sol_usd, tokens, total_usd } = data;
  if (format === "telegram") {
    const rows = [["SOL", sol.toFixed(4), `$${sol_usd.toFixed(2)}`]];
    for (const t of tokens) {
      if (t.symbol === "SOL" || t.usd <= 0.01) continue;
      rows.push([t.symbol, t.balance.toString(), `$${t.usd.toFixed(2)}`]);
    }
    return `${mdTable(["Token", "Balance", "USD"], rows, ["l", "r", "r"])}\n\n**Total: $${total_usd.toFixed(2)}**`;
  }
  // terminal
  const lines = tokens
    .filter(t => t.symbol !== "SOL" && t.usd > 0.01)
    .map(t => `  ${t.symbol.padEnd(6)}: ${t.balance.toString().padEnd(12)} ($${t.usd.toFixed(2)})`)
    .join("\n");
  return `Wallet Holdings ($${total_usd.toFixed(2)}):\n  SOL:   ${sol.toFixed(4)} ($${sol_usd.toFixed(2)})\n${lines}`;
}

/**
 * Format positions list.
 * @param {Array} positions
 * @param {'terminal'|'telegram'} format
 * @param {boolean} solMode
 * @returns {string}
 */
export function formatPositions(positions, format = "terminal", solMode = false) {
  if (!positions.length) return "  No open positions.";
  const currency = solMode ? "◎" : "$";
  if (format === "telegram") {
    return mdTable(
      ["Pair", "Status", "Fees"],
      positions.map(p => [
        p.pair,
        p.in_range ? "in-range ✓" : "OOR ⚠",
        `${currency}${p.unclaimed_fees_usd}`,
      ]),
      ["l", "l", "r"],
    );
  }
  // terminal
  const lines = positions.map(p => {
    const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
    return `  ${p.pair.padEnd(16)} ${status}  fees: ${currency}${p.unclaimed_fees_usd}`;
  }).join("\n");
  return `Positions: ${positions.length}\n${lines}`;
}
