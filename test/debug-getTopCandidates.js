const originalFetch = global.fetch;
global.fetch = async () => ({
  ok: true,
  json: async () => ({ data: [], page: 1, total: 0 }),
});

import('../src/screening/discovery.js').then(async (mod) => {
  try {
    const result = await mod.getTopCandidates({ limit: 1 });
    console.log('Result:', JSON.stringify(result));
  } catch (e) {
    console.log('Error:', e.message);
    console.log('Stack:', e.stack.split('\n').slice(0, 10).join('\n'));
  }
}).finally(() => {
  global.fetch = originalFetch;
});
