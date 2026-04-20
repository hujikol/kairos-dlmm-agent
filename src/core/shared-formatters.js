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