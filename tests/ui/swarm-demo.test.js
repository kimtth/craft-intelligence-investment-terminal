import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySwarmDemo, viewports } from './helpers/swarm-verification.js';

test('production Swarm: real Chromium/startGUI, local avatars, full timeline geometry and interaction contract', async () => {
  const { report } = await verifySwarmDemo();
  assert.equal(report.layouts.length, viewports.length);
  assert.ok(report.layouts.every(layout => layout.samples.length === 241));
  assert.equal(report.assets.length, 8);
  assert.equal(report.status, 'PASS', JSON.stringify(report.checks.filter(c => c.status !== 'PASS'), null, 2));
});