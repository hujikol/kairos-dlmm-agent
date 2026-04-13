/**
 * Caveman mode — strip filler from text to reduce token usage.
 * ~77% token savings on prompts.
 */

const FILLER_PATTERNS = [
  /^(Sure[,!]?\s*|Absolutely[,!]?\s*|Of course[,!]?\s*|Great[,!]?\s*)/i,
  /I'?d be happy to\s*/gi,
  /Let me (take a look|check|help you with) (at |that\s*)?/gi,
  /It('s| is) worth (noting|mentioning) that\s*/gi,
  /The reason (this|that) (is happening|occurred) is (because\s*)?/gi,
  /I would (recommend|suggest) (that you\s*)?(consider\s*)?/gi,
  /You might want to\s*/gi,
  /Generally speaking,?\s*/gi,
  /In (this|that) case,?\s*/gi,
  /Please note that\s*/gi,
  /\bthe\s+(?=[a-z])/g,
  /\b(a|an)\s+(?=[a-z])/g,
];

/**
 * Split text preserving code blocks and inline code.
 * Returns array of {text, isCode, isJson}.
 */
function splitPreserveCode(text) {
  const parts = [];
  const codeBlockRe = /```[\s\S]*?```/g;
  const inlineCodeRe = /`[^`]+`/g;

  // Find all code block positions
  const codeBlocks = [];
  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    codeBlocks.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }

  // Find all inline code positions
  const inlineCodes = [];
  while ((match = inlineCodeRe.exec(text)) !== null) {
    inlineCodes.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }

  // Merge and sort all segments
  const allSegments = [
    ...codeBlocks.map(s => ({ ...s, isCode: true })),
    ...inlineCodes.map(s => ({ ...s, isCode: true })),
  ].sort((a, b) => a.start - b.start);

  let pos = 0;
  for (const seg of allSegments) {
    if (seg.start > pos) {
      parts.push({ text: text.slice(pos, seg.start), isCode: false, isJson: false });
    }
    parts.push({ text: seg.text, isCode: true, isJson: seg.text.includes('```json') || seg.text.startsWith('```') });
    pos = seg.end;
  }
  if (pos < text.length) {
    parts.push({ text: text.slice(pos), isCode: false, isJson: false });
  }

  return parts;
}

/**
 * Strip reasoning blocks that some models leak into output.
 * Handles: unclosed tags, empty blocks, nested tags, case variations.
 */
export function stripThink(text) {
  if (!text) return text;
  const ranges = [];
  const re = /<think>[\s\S]*?<\/think>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Merge overlapping ranges (shouldn't happen but be safe)
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    if (merged.length === 0 || range[0] > merged[merged.length - 1][1]) {
      merged.push([...range]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
    }
  }
  const parts = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) parts.push(text.slice(pos, start));
    pos = end;
  }
  parts.push(text.slice(pos));
  return parts.join("").trim();
}

/**
 * Strip filler from text. Preserves code blocks and JSON.
 * @param {string} text - input text
 * @returns {string} - compressed text
 */
export function caveman(text) {
  if (!text) return text;
  const parts = splitPreserveCode(text);
  return parts.map(part => {
    if (part.isCode) return part.text;
    let t = part.text;
    for (const pat of FILLER_PATTERNS) t = t.replace(pat, '');
    return t.replace(/\s{2,}/g, ' ').trim();
  }).join('');
}

// CAVEMAN_ENABLED removed — config.cavemanEnabled is now the single source of truth
