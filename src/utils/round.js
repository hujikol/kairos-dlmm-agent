/**
 * Round a number to a given number of decimal places.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals = 4) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
module.exports = { roundTo };