// TEST ONLY offline E2E: production DOM -> HTTP -> Node bridge -> real Python RPC,
// collector and immutable temporary archive. Only Yahoo IO is fixture data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from './helpers/dependencies.js';
import { connectChild, interpreterPath, ROOT } from '../../ui/backend.js';
import { startGUI } from '../../ui/gui-server.js';

test('explicit dates travel through every production layer and reload exactly like public CLI', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'itt-dates-e2e-'));
  const store = path.join(directory, 'market');
  const python = interpreterPath();
  const backend = connectChild(spawn(python, ['-u', 'tests/market_date_rpc_fixture.py'], {
    cwd: ROOT, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  const calls = [];
  // Test-only store isolation: date/symbol payloads are passed through unchanged.
  const app = await startGUI({ backend: {
    on: (...args) => backend.on(...args), close: () => backend.close(),
    request(method, params) {
      assert.ok(['market.show', 'market.fetch'].includes(method));
      assert.equal(params.store, path.join(ROOT, '.itt/market'));
      const isolated = { ...params, store };
      calls.push({ method, params: isolated });
      return backend.request(method, isolated);
    },
  } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(app.origin)) external.push(request.url()); });
  await page.goto(app.url);
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'error');
  await page.locator('#rail-sources').click();
  await page.locator('#research-symbols').fill('SPY, MSFT');
  await page.locator('#assets-start').fill('2024-01-03');
  await page.locator('#assets-end').fill('2024-01-04');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api')
    && response.request().postDataJSON().method === 'market.fetch');
  await page.locator('#research-fetch').click();
  const envelope = await (await responsePromise).json();
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const fetched = envelope.result;
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#assets-requested')).toContainText('2024-01-03 — 2024-01-04 (both inclusive)');
  const table = await page.locator('#assets-table tbody tr').evaluateAll(rows => rows.map(row => [...row.cells].slice(0, 5).map(cell => cell.textContent)));
  assert.deepEqual(table, [['SPY', 'USD', '2024-01-03', '2024-01-04', '2'], ['MSFT', 'USD', '2024-01-04', '2024-01-04', '1']]);
  assert.deepEqual(calls.find(call => call.method === 'market.fetch').params, {
    symbols: ['SPY', 'MSFT'], start: '2024-01-03', end: '2024-01-04', store,
  });
  for (const url of Object.values(fetched.manifest.request_urls)) {
    const query = new URL(url).searchParams;
    assert.equal(query.get('period1'), '1704240000'); assert.equal(query.get('period2'), '1704412800');
    assert.equal(query.has('range'), false);
  }
  const filesBefore = await fs.readdir(store, { recursive: true });
  const readCLI = async () => {
    const { stdout, stderr } = await promisify(execFile)(python, ['-m', 'itt.cli', 'market', 'show', '--store', store], { cwd: ROOT });
    assert.equal(stderr, '');
    const reply = JSON.parse(stdout); assert.equal(reply.ok, true); return reply.result;
  };
  assert.deepEqual(await readCLI(), fetched, 'entire public CLI result, not only coverage');
  await page.locator('#assets-verify').click();
  await expect(page.locator('#assets-table')).toContainText('Saved bytes verified');
  await page.reload();
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
  await page.locator('#rail-sources').click();
  await expect(page.locator('#assets-start')).toHaveValue('2024-01-03');
  await expect(page.locator('#assets-end')).toHaveValue('2024-01-04');
  assert.deepEqual(await readCLI(), fetched);
  assert.deepEqual(await fs.readdir(store, { recursive: true }), filesBefore);
  await page.locator('#source-top').click();
  await expect(page.locator('#source-content')).toContainText('2024-01-03 — 2024-01-04 (inclusive) / 1d');
  await page.keyboard.press('Escape');
  // A second explicit download publishes a new archive without overwriting the first.
  const manifestPath = path.join(store, fetched.manifest.id, 'manifest.json');
  const original = await fs.readFile(manifestPath);
  await page.locator('#research-fetch').click();
  await expect(page.locator('#research-source')).not.toContainText(fetched.manifest.id);
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
  assert.deepEqual(await fs.readFile(manifestPath), original);
  assert.notEqual((await readCLI()).manifest.id, fetched.manifest.id);
  assert.equal(calls.filter(call => call.method === 'market.fetch').length, 2);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});