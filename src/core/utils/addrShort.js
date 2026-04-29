/**
 * Shorten a Solana address for display.
 * @param {string} addr - Base58 address
 * @returns {string} - Shortened address (4...4) or original if too short
 */
export function addrShort(addr) {
  if (!addr || typeof addr !== 'string' || addr.length < 8) return addr || '';
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}