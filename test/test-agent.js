/**
 * Test that agent module can be imported without errors.
 * Run with: npm test
 */

import { it, afterEach, after } from 'node:test';
import { fileURLToPath } from 'url';
import path from 'path';
import { closeDB } from '../src/core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  closeDB();
});

it('agent/react.js can be imported without error', async () => {
  const mod = await import('../src/agent/react.js');
  if (typeof mod.agentLoop !== 'function') throw new Error('agentLoop not exported');
});

after(() => { process.exit(0); });
