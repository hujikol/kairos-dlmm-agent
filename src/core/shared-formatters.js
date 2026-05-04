/**
 * Shared formatters for Telegram and REPL output.
 */

/**
 * Format candidates as ASCII table (REPL) or compact text (Telegram).
 * @param {Array} candidates
 * @param {'terminal'|'telegram'} format
 * @returns {string}
 */
export function formatCandidates(candidates, format = "terminal") {
  if (!candidates.length) return "  No eligible pools found right now.";

  if (format === "telegram") {
    const lines = candidates.map((p, i) => {
      const name = p.name.slice(0, 10).padEnd(10);
      const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.slice(0, 5).padStart(7);
      const vol = `$${(p.volume_window || 0) / 1000 > 0 ? (p.volume_window / 1000).toFixed(1) : '0.0'}k`.padStart(5);
      const org = String(p.organic_score).padStart(3);
      return `${String(i + 1).padEnd(2)}  ${name}  ${ftvl}  ${vol}  ${org}`;
    });
    return ["#   Pool        fee/TVL  vol    org", "──  ──────────  ───────  ─────  ───", ...lines].join("\n");
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
    const lines = tokens
      .filter(t => t.symbol !== "SOL" && t.usd > 0.01)
      .map(t => `  ${t.symbol.padEnd(6)}: ${t.balance.toString().padEnd(12)} ($${t.usd.toFixed(2)})`)
      .join("\n");
    return `Wallet Holdings ($${total_usd.toFixed(2)}):\n  SOL:   ${sol.toFixed(4)} ($${sol_usd.toFixed(2)})\n${lines}`;
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
    const lines = positions.map(p => {
      const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
      return `  ${p.pair.padEnd(16)} ${status}  fees: ${currency}${p.unclaimed_fees_usd}`;
    }).join("\n");
    return `Positions: ${positions.length}\n${lines}`;
  }
  // terminal
  const lines = positions.map(p => {
    const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
    return `  ${p.pair.padEnd(16)} ${status}  fees: ${currency}${p.unclaimed_fees_usd}`;
  }).join("\n");
  return `Positions: ${positions.length}\n${lines}`;
}

/**
 * Shared ASCII table formatter for Telegram and other text-based output.
 *
 * Takes an array of row objects with cells and alignment, returns a
 * formatted ASCII table string.
 *
 * @param {Array<{cells: string[], align?: ('left'|'right')[]}>} rows
 * @param {number[]} colWidths - per-column character widths
 * @returns {string}
 */
export function buildAsciiTable(rows, colWidths) {
  if (rows.length === 0) return colWidths.map(w => "─".repeat(w)).join("  ");

  const divider = colWidths.map((w) => "─".repeat(w)).join("  ");

  // First row is the header — put divider AFTER it (not before)
  const [header, ...body] = rows;

  const headerLine = header.cells.map((cell, i) => {
    const width = colWidths[i] ?? 10;
    const align = header.align?.[i] ?? "left";
    const content = String(cell).slice(0, width);
    return align === "right" ? content.padStart(width) : content.padEnd(width);
  }).join("  ");

  const bodyLines = body.map((row) =>
    row.cells.map((cell, i) => {
      const width = colWidths[i] ?? 10;
      const align = row.align?.[i] ?? "left";
      const content = String(cell).slice(0, width);
      return align === "right" ? content.padStart(width) : content.padEnd(width);
    }).join("  ")
  );

  return [headerLine, divider, ...bodyLines, divider].join("\n");
}