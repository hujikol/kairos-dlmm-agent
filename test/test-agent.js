/**
 * Test that agent module can be imported without errors.
 * Run with: npm test
 */

import { it, before } from 'node:test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

it('agent/react.js can be imported without error', async () => {
  const mod = await import('../src/agent/react.js');
  if (typeof mod.agentLoop !== 'function') throw new Error('agentLoop not exported');
});
