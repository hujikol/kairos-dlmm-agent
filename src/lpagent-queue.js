/**
 * LPAgent rate-limit queue — token-bucket at 4 rpm.
 * Prevents hammering the LPAgent API beyond rate limits.
 */

const RATE = 4;
const BUCKET = { tokens: RATE, lastRefill: Date.now() };
const queue = [];
let processing = false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function refillBucket() {
  const now = Date.now();
  const diff = (now - BUCKET.lastRefill) / 60_000;
  BUCKET.tokens = Math.min(RATE, BUCKET.tokens + diff * RATE);
  BUCKET.lastRefill = now;
}

async function drainQueue() {
  processing = true;
  while (queue.length > 0) {
    refillBucket();
    if (BUCKET.tokens < 1) {
      await sleep(60_000 / RATE);
      refillBucket();
    }
    const { fn, resolve, reject } = queue.shift();
    BUCKET.tokens--;
    try { resolve(await fn()); }
    catch (e) { reject(e); }
  }
  processing = false;
}

/**
 * Enqueue an LPAgent call. Returns a promise that resolves when the call executes.
 * @param {Function} fn - async function to execute
 */
export function enqueueLPAgent(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!processing) drainQueue();
  });
}
