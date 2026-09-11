// Renderer regressions only: synthetic transport fixture, no Python, Yahoo or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';
import { criterion, CRITERIA_OPERANDS, CRITERIA_OPERATORS } from '../../ui/criteria-schema.js';

const rule = (left = 'close', right = '10', op = 'gt') => ({ left, op, right });
const nested = count => {
  let value = rule();
  for (let i = 0; i < count; i++) value = { not: value };
  return value;
};
const snapshot = {
  manifest: { id: '77777777-7777-4777-8777-777777777777', kind: 'real_market_snapshot',
    provider: 'Yahoo Finance', raw_sha256: {}, request_urls: {} },
  summary: [],
  symbols: [{ symbol: 'SPY', currency: 'USD', bars: [
    { date: '2026-01-02', timestamp: 1767358800, open: '100', high: '102', low: '99', close: '101', volume: '1000' },
    { date: '2026-01-05', timestamp: 1767618000, open: '101', high: '103', low: '100', close: '102', volume: '1100' },
  ] }],
};

test('renderer imports shared criteria schema as a module without independent validators or budgets', async () => {
  const source = await readFile(new URL('../../ui/gui/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../../ui/gui/index.html', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{\s*criterion as validCriterion,\s*CRITERIA_OPERANDS as OPERANDS,\s*CRITERIA_OPERATORS as OPERATORS\s*\}\s*from '\/criteria-schema\.js'/);
  assert.doesNotMatch(source, /function valid(?:Operand|Criterion)|const OPERANDS\s*=|const OPERATORS\s*=|cost\s*\+=\s*weight/);
  assert.match(html, /<script src="\.\/research\.js" defer><\/script>[\s\S]*<script src="\.\/app\.js" type="module"><\/script>/);
});

test('actual browser shares schema, initializes deferred research and preserves JSON review gating', async t => {
  const calls = [], errors = [];
  const app = await startGUI({ backend: {
    on() {}, async close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'market.show') return structuredClone(snapshot);
      // No financial result is invented; only observe the explicit submitted request.
      throw Object.assign(new Error('Renderer test rejects execution'), { code: 'input_rejected' });
    },
  } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    const response = await fetch(app.origin + '/criteria-schema.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal(await response.text(), await readFile(new URL('../../ui/criteria-schema.js', import.meta.url), 'utf8'));

    // Hold the earlier deferred script until the module dependency has downloaded.
    // This exercises ordering rather than relying on a fast local research response.
    let releaseResearch;
    const schemaLoaded = new Promise(resolve => { releaseResearch = resolve; });
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/criteria-schema.js') releaseResearch();
    });
    await page.route('**/research.js', async route => { await schemaLoaded; await route.continue(); });
    await page.goto(app.url);
    assert.deepEqual(errors, [], 'Actual app must initialize before testing review controls; do not insert missing production DOM');
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    assert.equal(await page.evaluate(() => typeof window.ITTResearch), 'function');
    await page.unroute('**/research.js');
    await page.reload();
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    await page.locator('#nav-research').click();
    await expect(page.locator('#research-correlation')).toBeVisible();
    await page.locator('#nav-backtest').click();
    await expect(page.locator('#backtest-workspace')).toBeVisible();
    await expect(page.locator('#criteria-source-natural')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#backtest-preview')).toBeDisabled();
    await page.locator('#criteria-source-manual').click();
    await page.locator('#criteria-manual > summary').click();
    for (const id of ['criteria-entry-left', 'criteria-exit-left', 'criteria-operands']) {
      assert.deepEqual(await page.locator(`#${id} option`).evaluateAll(options => options.map(option => option.value)), [...CRITERIA_OPERANDS]);
    }
    for (const id of ['criteria-entry-op', 'criteria-exit-op']) {
      assert.deepEqual(await page.locator(`#${id} option`).evaluateAll(options => options.map(option => option.value)), [...CRITERIA_OPERATORS]);
    }
    await expect(page.locator('#backtest-run')).toBeDisabled();
    await page.locator('#criteria-entry-right').fill('volume');
    await page.locator('#backtest-preview').click();
    await expect(page.locator('#backtest-error')).toBeVisible();
    await expect(page.locator('#backtest-run')).toBeDisabled();
    await page.locator('#criteria-expert > summary').click();
    await page.locator('#criteria-advanced-enabled').check();

    const expensive = { all: Array.from({ length: 9 }, () => rule({ indicator: 'sma', period: 252 }, '0', 'crosses_above')) };
    const tooManyNodes = { all: Array.from({ length: 32 }, () => ({ not: rule() })) };
    const cases = [
      ['numeric left', rule(10), false],
      ['decimal-string left', rule('10'), false],
      ['volume shorthand left', rule('volume'), false],
      ['volume shorthand right', rule('close', 'volume'), false],
      ['volume field', rule({ field: 'volume' }), true],
      ['numeric right', rule('close', 10), true],
      ['bounded exponent', rule('close', '1e100'), true],
      ['oversized exponent', rule('close', '1e101'), false],
      ['depth 12', nested(10), true],
      ['depth 13', nested(11), false],
      ['node budget', tooManyNodes, false],
      ['weighted cross cost', expensive, false],
      ['group budget', { all: Array.from({ length: 33 }, () => rule()) }, false],
      ['unknown key', { ...rule(), extra: true }, false],
      ['arithmetic/custom/lagged compound', { all: [
        rule({ operation: 'divide', left: { field: 'volume' }, right: { field: 'volume', lag: 2 } }, '1.2'),
        { not: rule({ indicator: 'return', period: 5 }, -0.05, 'lte') },
      ] }, true],
    ];
    for (const [name, entry, accepted] of cases) {
      await t.test(name, async () => {
        assert.equal(criterion(entry), accepted, 'fixed expectation agrees with shared validator');
        const text = JSON.stringify({ entry, exit: rule('close', '5', 'lt') });
        await page.locator('#criteria-advanced-json').fill(text);
        await expect(page.locator('#backtest-run')).toBeDisabled();
        await page.locator('#backtest-preview').click();
        assert.equal(await page.locator('#backtest-review').isVisible(), accepted);
        assert.equal(await page.locator('#backtest-run').isEnabled(), accepted);
        assert.equal(await page.locator('#backtest-error').isVisible(), !accepted);
        assert.equal(await page.locator('#criteria-advanced-json').inputValue(), text, 'review does not rewrite user JSON');
      });
    }
    assert.ok(calls.every(call => call.method === 'market.show'), 'preview never sends a simulation');
    const reviewed = JSON.parse(await page.locator('#backtest-spec').textContent());
    assert.deepEqual(reviewed.entry.all[0].left.left, { field: 'volume', lag: 0 });
    assert.deepEqual(reviewed.entry.all[0].left.right, { field: 'volume', lag: 2 });
    assert.deepEqual(reviewed.entry.all[1].not.left, { indicator: 'return', period: 5, lag: 0 });
    await page.locator('#backtest-run').click();
    await expect(page.locator('#backtest-error')).toBeVisible();
    const submitted = calls.filter(call => call.method === 'market.backtest.stream');
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].params.spec, reviewed, 'wire request is the exact reviewed normalized JSON');
    await page.locator('#criteria-advanced-json').fill(JSON.stringify({ entry: rule(10), exit: rule() }));
    await expect(page.locator('#backtest-run')).toBeDisabled();
    await expect(page.locator('#backtest-review')).toBeHidden();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});