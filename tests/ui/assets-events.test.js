// Production startGUI/DOM integration with transport fixtures only.
// No Yahoo/model requests, archive writes or browser-side financial calculations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

const dates = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];
const snapshot = (symbols = ['SPY', 'QQQ'], id = '77777777-7777-4777-8777-777777777777') => ({
  manifest: { id, kind: 'real_market_snapshot', provider: 'Yahoo Finance', raw_sha256: {}, request_urls: {} }, summary: [],
  symbols: symbols.map(symbol => ({ symbol, currency: 'USD', bars: dates.map(date => ({
    date, timestamp: Date.parse(`${date}T21:00:00Z`) / 1000,
    open: '100', high: '102', low: '99', close: '101', volume: '1000',
  })) })),
});
const rejected = () => Object.assign(new Error('TEST backend rejects this request'), { code: 'input_rejected' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const resultFor = spec => ({
  archive_id: spec.archive_id, symbol: spec.symbol, target_symbol: spec.target_symbol, spec,
  analysis_type: 'retrospective_event_study_not_tradable_backtest', contract: { version: 'trigger-v1' },
  event_count: 0, events: [], summary: spec.horizons.map(horizon => ({
    horizon, n: 0, mean: null, median: null, win_rate: null, overlapping_samples: false,
  })), warnings: [], limitations: ['TEST ONLY transport fixture; no performance evidence.'],
});
async function open(t, options = {}) {
  let saved = options.saved === null ? null : options.saved || snapshot();
  const calls = [], errors = [], external = [];
  const app = await startGUI({ backend: {
    on() {}, async close() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === 'market.show') { if (!saved) throw rejected(); return structuredClone(saved); }
      if (method === 'market.fetch') {
        if (options.fetch) saved = await options.fetch(params);
        else saved = snapshot(params.symbols, '88888888-8888-4888-8888-888888888888');
        return structuredClone(saved);
      }
      if (method === 'market.trigger') return options.trigger ? options.trigger(params.spec) : resultFor(params.spec);
      throw rejected();
    },
  } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (options.now) await page.clock.setFixedTime(new Date(options.now));
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(app.origin)) external.push(request.url()); });
  await page.goto(app.url);
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', saved ? 'success' : 'error');
  return { page, calls, errors, external };
}

test('Assets dates are leap-safe, explicit, inclusive and validated without changing selected symbols', async t => {
  const { page, calls, errors } = await open(t, { now: '2024-02-29T12:00:00', saved: snapshot(['MSFT', 'TLT']) });
  await page.locator('#rail-sources').click();
  await expect(page.locator('#assets-start')).toHaveValue('2019-02-28');
  await expect(page.locator('#assets-end')).toHaveValue('2024-02-29');
  await expect(page.locator('#research-symbols')).toHaveValue('MSFT, TLT');
  await expect(page.locator('#assets-requested')).toContainText('explicit date bounds were not recorded');
  await expect(page.locator('#assets-download-help')).toContainText('full coverage is not guaranteed');
  assert.equal(await page.locator('#research-fetch-form select').count(), 0, 'no all/max preset');
  for (const [start, end, reason] of [['', '2024-01-04', 'valid Start date'],
    ['2024-01-04', '', 'valid Start date'], ['2024-01-05', '2024-01-04', 'on or after']]) {
    await page.locator('#assets-start').fill(start); await page.locator('#assets-end').fill(end);
    await page.locator('#research-fetch').click();
    await expect(page.locator('#assets-error')).toContainText(reason);
    assert.equal(calls.length, 1, 'invalid bounds never reach HTTP/backend');
  }
  await page.locator('#assets-start').fill('2024-01-04');
  await page.locator('#assets-end').fill('2024-01-04');
  await page.locator('#research-fetch').click();
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
  const request = calls.find(call => call.method === 'market.fetch');
  assert.deepEqual({ ...request.params, store: undefined }, {
    symbols: ['MSFT', 'TLT'], start: '2024-01-04', end: '2024-01-04', store: undefined,
  });
  await expect(page.locator('#research-symbols')).toHaveValue('MSFT, TLT');
  await expect(page.locator('#assets-start')).toHaveValue('2024-01-04');
  assert.deepEqual(errors, []);
});

test('saved requested dates and distinct actual coverage survive refresh; edited date/symbol drafts are not overwritten', async t => {
  const saved = snapshot(['SPY', 'MSFT']);
  saved.manifest.requested_bounds = { start: '2021-01-01', end: '2026-01-10', inclusive: true, interval: '1d' };
  saved.symbols[1].bars = saved.symbols[1].bars.slice(2);
  const { page, calls, errors, external } = await open(t, { saved });
  await page.locator('#rail-sources').click();
  await expect(page.locator('#assets-start')).toHaveValue('2021-01-01');
  await expect(page.locator('#assets-end')).toHaveValue('2026-01-10');
  await expect(page.locator('#assets-requested')).toContainText('2021-01-01 — 2026-01-10 (both inclusive)');
  const coverage = await page.locator('#assets-table tbody tr').evaluateAll(rows => rows.map(row => [...row.cells].slice(0, 5).map(cell => cell.textContent)));
  assert.deepEqual(coverage, [
    ['SPY', 'USD', '2026-01-02', '2026-01-07', '4'], ['MSFT', 'USD', '2026-01-06', '2026-01-07', '2'],
  ]);
  await page.locator('#research-symbols').fill('GLD, TLT');
  await page.locator('#assets-start').fill('2022-03-01');
  await page.locator('#assets-end').fill('2025-12-31');
  await page.locator('#assets-verify').click();
  await expect(page.locator('#assets-table')).toContainText('Saved bytes verified');
  await expect(page.locator('#research-symbols')).toHaveValue('GLD, TLT');
  await expect(page.locator('#assets-start')).toHaveValue('2022-03-01');
  await expect(page.locator('#assets-end')).toHaveValue('2025-12-31');
  await expect(page.locator('#assets-requested')).toContainText('2021-01-01 — 2026-01-10');
  await page.reload();
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
  await page.locator('#rail-sources').click();
  await expect(page.locator('#research-symbols')).toHaveValue('SPY, MSFT');
  await expect(page.locator('#assets-start')).toHaveValue('2021-01-01');
  await expect(page.locator('#assets-end')).toHaveValue('2026-01-10');
  assert.equal(calls.filter(call => call.method === 'market.fetch').length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('multi-year market change is Archive delta; 1Y shows 252 observations, Archive shows the saved window', async t => {
  const saved = snapshot(['SPY']);
  saved.symbols[0].bars = Array.from({ length: 400 }, (_, i) => ({ ...saved.symbols[0].bars[0],
    date: new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10), timestamp: Date.UTC(2024, 0, 2 + i, 21) / 1000,
  }));
  saved.summary = [{ symbol: 'SPY', first_date: '2024-01-02', last_date: saved.symbols[0].bars.at(-1).date,
    last_price: '101', pricechange_pct: '27.5', metric: 'price_change_not_investment_return' }];
  const { page, errors } = await open(t, { saved });
  await expect(page.locator('#price-change')).toHaveText('+27.50%');
  await expect(page.locator('.quote-change')).toContainText('Archive Δ');
  await expect(page.locator('[data-testid="watch-SPY"]')).toHaveAttribute('title', /Archive Δ 27.5%/);
  await page.locator('#tab-prices').click();
  await expect(page.locator('#prices-body tr')).toHaveCount(400);
  await page.locator('[data-period="1Y"]').click();
  await expect(page.locator('#prices-body tr')).toHaveCount(252);
  await expect(page.locator('#price-change')).toHaveText('+27.50%');
  await page.locator('[data-period="Archive"]').click();
  await expect(page.locator('#prices-body tr')).toHaveCount(400);
  assert.deepEqual(errors, []);
});
async function events(page) {
  await page.locator('#nav-research').click();
  await page.locator('#research-tab-trigger').click();
}

async function reviewBacktest(page) {
  await page.locator('#nav-backtest').click();
  await page.locator('#criteria-source-manual').click();
  if (!await page.locator('#criteria-manual').evaluate(element => element.open)) {
    await page.locator('#criteria-manual > summary').click();
  }
  await page.locator('#criteria-entry-left').selectOption('close');
  await page.locator('#criteria-entry-op').selectOption('gt');
  await page.locator('#criteria-entry-right').fill('100');
  await page.locator('#backtest-start').selectOption(dates[1]);
  await page.locator('#backtest-end').selectOption(dates[3]);
  await page.locator('#backtest-preview').click();
  await expect(page.locator('#backtest-run')).toBeEnabled();
  return JSON.parse(await page.locator('#backtest-spec').textContent());
}

async function exportedTrigger(page, expected) {
  await expect(page.locator('#trigger-form')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#trigger-result')).toBeVisible();
  await expect(page.locator('#trigger-status')).toContainText('Analysis complete');
  await expect(page.locator('#trigger-download')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.locator('#trigger-download').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'itt-trigger.json');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), expected);
  assert.equal(await download.failure(), null);
}

test('reviewed source switch immediately runs and retains the completed export across navigation; source and entry edits invalidate', async t => {
  const { page, calls, errors, external } = await open(t);
  const reviewed = await reviewBacktest(page);
  await events(page);
  await expect(page.locator('#trigger-condition-source')).toHaveValue('manual');
  await page.locator('#trigger-target-symbol').selectOption('QQQ');
  await page.locator('#trigger-condition-source').selectOption('backtest');
  // No navigation or unrelated render between the producer transition and submit.
  await page.locator('#trigger-run').click();
  await expect(page.locator('#trigger-form')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#trigger-result')).toBeVisible();
  const spec = calls.filter(call => call.method === 'market.trigger').at(-1).params.spec;
  assert.deepEqual(spec, { archive_id: reviewed.archive_id, symbol: reviewed.symbol,
    target_symbol: 'QQQ', start: reviewed.start, end: reviewed.end, condition: reviewed.entry, horizons: [1, 5, 20] });
  await exportedTrigger(page, resultFor(spec));
  for (const nav of ['nav-markets', 'nav-backtest', 'nav-swarm']) {
    await page.locator(`#${nav}`).click();
    await events(page);
    await exportedTrigger(page, resultFor(spec));
  }
  await page.locator('#nav-backtest').click();
  await page.locator('#criteria-entry-right').fill('101');
  await events(page);
  await expect(page.locator('#trigger-result')).toBeHidden();
  await expect(page.locator('#trigger-download')).toBeHidden();
  await expect(page.locator('#trigger-run')).toBeDisabled();
  await reviewBacktest(page);
  await events(page);
  await page.locator('#trigger-run').click();
  await exportedTrigger(page, resultFor(spec));
  await page.locator('#nav-backtest').click();
  await page.locator('#criteria-source-natural').click();
  await events(page);
  await expect(page.locator('#trigger-result')).toBeHidden();
  await expect(page.locator('#trigger-run')).toBeDisabled();
  await page.locator('#trigger-condition-source').selectOption('manual');
  await page.locator('#trigger-run').click();
  await expect(page.locator('#trigger-result')).toBeVisible();
  const manualSpec = calls.filter(call => call.method === 'market.trigger').at(-1).params.spec;
  // Independent studies must not acquire a dependency on Backtest or the Markets selection.
  await reviewBacktest(page);
  await page.locator('#backtest-symbol').selectOption('QQQ');
  await events(page);
  await exportedTrigger(page, resultFor(manualSpec));
  await page.locator('#trigger-condition-source').selectOption('backtest');
  await expect(page.locator('#trigger-result')).toBeHidden();
  await expect(page.locator('#trigger-download')).toBeHidden();
  assert.ok(!calls.some(call => /backtest|portfolio|copilot/.test(call.method)));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

for (const source of ['manual', 'backtest']) test(`${source} delayed event responses reject source, target, symbol, entry, archive and loading transitions`, async t => {
  let gate, fetchGate;
  const { page, calls, errors, external } = await open(t, {
    trigger: () => (gate = deferred()).promise,
    fetch: () => (fetchGate = deferred()).promise,
  });
  const roundTrip = async (id, next) => {
    const control = page.locator(`#${id}`), previous = await control.inputValue();
    await control.selectOption(next); await control.selectOption(previous);
  };
  const edits = {
    source: () => roundTrip('trigger-condition-source', source === 'manual' ? 'backtest' : 'manual'),
    target: () => roundTrip('trigger-target-symbol', 'QQQ'),
    symbol: async () => {
      if (source === 'manual') await roundTrip('trigger-symbol', 'QQQ');
      else { await page.locator('#nav-backtest').click(); await roundTrip('backtest-symbol', 'QQQ'); }
    },
    entry: async () => {
      if (source === 'backtest') await page.locator('#nav-backtest').click();
      const control = page.locator(source === 'manual' ? '#trigger-right' : '#criteria-entry-right');
      const previous = await control.inputValue();
      await control.fill('101'); await control.fill(previous);
    },
    ...(source === 'backtest' ? { ruleSource: async () => {
      await page.locator('#nav-backtest').click();
      await page.locator('#criteria-source-natural').click();
      await page.locator('#criteria-source-manual').click();
    } } : {}),
    sameArchive: async () => {
      await page.locator('#rail-sources').click();
      await page.locator('#assets-verify').click();
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    },
    loading: async () => {
      await page.locator('#rail-sources').click();
      await page.locator('#research-fetch').click();
      await expect(page.locator('#research-fetch')).toBeDisabled();
      await expect.poll(() => !!fetchGate).toBe(true);
    },
    archive: async () => {
      fetchGate = null;
      await page.locator('#rail-sources').click();
      await page.locator('#research-fetch').click();
      await expect.poll(() => !!fetchGate).toBe(true);
      fetchGate.resolve(snapshot(['SPY', 'QQQ'], '99999999-9999-4999-8999-999999999999'));
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    await reviewBacktest(page);
    await events(page);
    await page.locator('#trigger-condition-source').selectOption(source);
    const before = calls.filter(call => call.method === 'market.trigger').length;
    await page.locator('#trigger-run').click();
    await expect.poll(() => calls.filter(call => call.method === 'market.trigger').length).toBe(before + 1);
    const requested = calls.filter(call => call.method === 'market.trigger').at(-1).params.spec;
    await edit();
    // Restore review as well as values: old requests must still fail the revision guard.
    if (source === 'backtest' && ['symbol', 'entry', 'ruleSource', 'sameArchive', 'archive'].includes(name)) await reviewBacktest(page);
    if (name === 'target' || name === 'ruleSource') gate.reject(rejected());
    else gate.resolve(resultFor(requested));
    await expect(page.locator('#trigger-form')).toHaveAttribute('aria-busy', 'false');
    await events(page);
    await expect(page.locator('#trigger-result'), name).toBeHidden();
    await expect(page.locator('#trigger-download'), name).toBeHidden();
    await expect(page.locator('#trigger-error'), name).toBeHidden();
    if (name === 'loading') {
      await expect(page.locator('#trigger-run')).toBeDisabled();
      fetchGate.resolve(snapshot());
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
      await events(page);
      await expect(page.locator('#trigger-result')).toBeHidden();
    }
  }
  assert.ok(!calls.some(call => /backtest|portfolio|copilot/.test(call.method)));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('rail database button opens global Assets, never provenance or an automatic download', async t => {
  const { page, calls, errors } = await open(t);
  for (const nav of ['nav-markets', 'nav-backtest', 'nav-research', 'nav-swarm']) {
    await page.locator(`#${nav}`).click();
    const before = calls.length;
    await page.locator('#rail-sources').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#assets-workspace')).toBeVisible();
    await expect(page.locator('#source-dialog')).not.toBeVisible();
    await expect(page.locator('#research-symbols')).toBeFocused();
    await expect(page.locator('#research-fetch')).toBeVisible();
    await expect(page.locator('#rail-sources')).toHaveAttribute('aria-label', 'Assets');
    await expect(page.locator('#rail-sources')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#nav-assets')).toHaveCount(0);
    await expect(page.locator('#copilot-panel')).toBeHidden();
    assert.equal(calls.length, before);
  }
  await page.locator('#research-symbols').fill('TLT, GLD');
  await page.locator('#research-fetch').click();
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(2);
  assert.deepEqual(calls.find(call => call.method === 'market.fetch').params.symbols, ['TLT', 'GLD']);
  await page.locator('#nav-markets').click();
  await expect(page.locator('#rail-sources')).not.toHaveAttribute('aria-current', 'page');
  await page.locator('#rail-sources').click();
  await expect(page.locator('#assets-workspace')).toBeVisible();
  await expect(page.locator('#source-dialog')).not.toBeVisible();
  assert.deepEqual(errors, []);
});

test('Assets download replaces shared universe, validates input, supplies all weights and preserves drafts/settings', async t => {
  const { page, calls, errors, external } = await open(t);
  await page.locator('#copilot-question').fill('TEST unsent Markets draft');
  const chat = await page.locator('#copilot-panel').elementHandle();
  await page.locator('#fetch-market').click();
  await expect(page.locator('#assets-workspace')).toBeVisible();
  await expect(page.locator('#research-fetch-form')).toBeVisible();
  await expect(page.locator('#copilot-panel')).toBeHidden();
  await expect(page.locator('.workspace-why')).toBeHidden();
  assert.equal(calls.length, 1, 'Markets Data opens Assets without fetching');
  await expect(page.locator('#research-symbols')).toHaveValue('SPY, QQQ');
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#assets-table')).toContainText('Saved bytes verified');
  for (const input of ['SPY, SPY', '', 'BAD/SYMBOL', Array.from({ length: 11 }, (_, i) => `A${i}`).join(',')]) {
    await page.locator('#research-symbols').fill(input);
    await page.locator('#research-fetch').click();
    await expect(page.locator('#assets-error')).toContainText('1–10 unique Yahoo symbols');
    assert.equal(calls.length, 1);
  }
  await page.locator('#research-symbols').fill('tlt, gld, spy, qqq');
  await page.locator('#research-fetch').click();
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(4);
  const fetched = calls.filter(call => call.method === 'market.fetch');
  assert.equal(fetched.length, 1);
  assert.deepEqual(fetched[0].params.symbols, ['TLT', 'GLD', 'SPY', 'QQQ']);
  await expect(page.locator('#research-source')).toContainText('88888888-8888-4888-8888-888888888888');
  await expect(page.locator('#assets-table')).toContainText('USD');
  await expect(page.locator('#assets-table')).toContainText(dates[0]);
  assert.deepEqual(await page.locator('#assets-table tbody tr').evaluateAll(rows => rows.map(row => row.cells[4].textContent)), ['4', '4', '4', '4']);
  await page.locator('#nav-backtest').click();
  for (const mode of ['portfolio', 'dynamic']) {
    await page.locator(`#backtest-tab-${mode}`).click();
    await expect(page.locator('#portfolio-weights input')).toHaveCount(4);
    assert.deepEqual(await page.locator('#portfolio-weights input').evaluateAll(inputs => inputs.map(input => input.dataset.symbol)), ['TLT', 'GLD', 'SPY', 'QQQ']);
    assert.deepEqual(await page.locator('#portfolio-weights input').evaluateAll(inputs => inputs.map(input => input.value)), ['0.25', '0.25', '0.25', '0.25']);
  }
  await page.locator('#backtest-open-assets').click();
  await expect(page.locator('#assets-workspace')).toBeVisible();
  await page.locator('#assets-verify').click();
  await expect(page.locator('#assets-table')).toContainText('Saved bytes verified');
  const before = calls.length;
  await page.locator('#research-symbols').fill('TLT, GLD');
  for (const nav of ['backtest', 'research', 'assets']) {
    await page.locator(nav === 'assets' ? '#rail-sources' : `#nav-${nav}`).click();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-settings')).toBeFocused();
  }
  await expect(page.locator('#research-symbols')).toHaveValue('TLT, GLD');
  assert.equal(calls.length, before, 'navigation/settings do not download or check Copilot');
  await page.locator('#nav-markets').click();
  await expect(page.locator('#copilot-question')).toHaveValue('TEST unsent Markets draft');
  assert.equal(await chat.evaluate(el => el === document.querySelector('#copilot-panel')), true);
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    for (const view of ['markets', 'assets']) {
      await page.locator(view === 'assets' ? '#rail-sources' : `#nav-${view}`).click();
      const controls = await page.locator('.topbar button:visible').evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect(); return { id: el.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }));
      for (const rect of controls) assert.ok(rect.left >= 0 && rect.right <= width, `${width} ${view}: ${rect.id} fits`);
      assert.ok(Math.max(...controls.map(rect => rect.top)) - Math.min(...controls.map(rect => rect.top)) < 24, 'compact one-row controls');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await expect(page.locator('#research-symbols')).toHaveValue('TLT, GLD, SPY, QQQ', 'reload restores archive, not an unsaved draft');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('independent Event studies run before Backtest review with exact source, condition, dates and horizons', async t => {
  const { page, calls, errors } = await open(t, { saved: snapshot(['TLT', 'GLD', 'SPY', 'QQQ']) });
  await events(page);
  await expect(page.locator('#trigger-condition-source')).toHaveValue('manual');
  await expect(page.locator('#trigger-run')).toBeEnabled();
  await expect(page.locator('#backtest-review')).toBeHidden();
  await page.locator('#trigger-symbol').selectOption('GLD');
  await page.locator('#trigger-target-symbol').selectOption('TLT');
  await page.locator('#trigger-left').selectOption('close');
  await page.locator('#trigger-op').selectOption('gte');
  await page.locator('#trigger-right').fill('100.25');
  await page.locator('#trigger-start').selectOption(dates[1]);
  await page.locator('#trigger-end').selectOption(dates[3]);
  await page.locator('#trigger-horizons').fill('1,2');
  await page.locator('#trigger-run').click();
  await expect(page.locator('#trigger-result')).toBeVisible();
  assert.deepEqual(calls.find(call => call.method === 'market.trigger').params.spec, {
    archive_id: '77777777-7777-4777-8777-777777777777', symbol: 'GLD', target_symbol: 'TLT',
    start: dates[1], end: dates[3], condition: { left: 'close', op: 'gte', right: '100.25' }, horizons: [1, 2],
  });
  await page.locator('#trigger-target-symbol').selectOption('QQQ');
  await expect(page.locator('#trigger-start')).toHaveValue(dates[1]);
  await expect(page.locator('#trigger-result')).toBeHidden();
  for (const [id, value, reason] of [['trigger-right', 'unsupported', 'Invalid condition'], ['trigger-horizons', '1,1', 'unique integers']]) {
    const original = await page.locator(`#${id}`).inputValue();
    await page.locator(`#${id}`).fill(value);
    await expect(page.locator('#trigger-run')).toBeDisabled();
    await expect(page.locator('#trigger-disabled-reason')).toContainText(reason);
    await page.locator(`#${id}`).fill(original);
  }
  await page.locator('#trigger-end').selectOption(dates[0]);
  await expect(page.locator('#trigger-run')).toBeDisabled();
  await expect(page.locator('#trigger-disabled-reason')).toContainText('end session after');
  await page.locator('#trigger-end').selectOption(dates[3]);
  await page.locator('#trigger-condition-source').selectOption('backtest');
  await expect(page.locator('#trigger-run')).toBeDisabled();
  await expect(page.locator('#trigger-disabled-reason')).toContainText('Review rules');
  await page.locator('#trigger-open-backtest').click();
  await page.locator('#criteria-source-manual').click();
  await page.locator('#backtest-preview').click();
  await expect(page.locator('#backtest-run')).toBeEnabled();
  const reviewed = JSON.parse(await page.locator('#backtest-spec').textContent());
  await events(page);
  await expect(page.locator('#trigger-run')).toBeEnabled();
  await expect(page.locator('#trigger-manual-fields')).toBeHidden();
  await page.locator('#trigger-run').click();
  await expect(page.locator('#trigger-result')).toBeVisible();
  const reused = calls.filter(call => call.method === 'market.trigger').at(-1).params.spec;
  assert.deepEqual(reused.condition, reviewed.entry);
  assert.equal(reused.start, reviewed.start); assert.equal(reused.end, reviewed.end);
  assert.ok(!calls.some(call => /backtest|portfolio|copilot/.test(call.method)));
  assert.deepEqual(errors, []);
});

test('event pending results and errors are discarded after input changes; current errors remain visible', async t => {
  let gate;
  const { page, calls, errors } = await open(t, { trigger: () => (gate = deferred()).promise });
  await events(page);
  await page.locator('#trigger-run').click();
  await expect.poll(() => calls.filter(call => call.method === 'market.trigger').length).toBe(1);
  await expect(page.locator('#trigger-disabled-reason')).toContainText('running');
  await page.locator('#trigger-right').fill('35');
  gate.resolve(resultFor(calls.at(-1).params.spec));
  await expect(page.locator('#trigger-run')).toBeEnabled();
  await expect(page.locator('#trigger-result')).toBeHidden();
  await page.locator('#trigger-run').click();
  await expect.poll(() => calls.filter(call => call.method === 'market.trigger').length).toBe(2);
  await page.locator('#trigger-horizons').fill('1,2');
  gate.reject(rejected());
  await expect(page.locator('#trigger-run')).toBeEnabled();
  await expect(page.locator('#trigger-error')).toBeHidden();
  await page.locator('#trigger-run').click();
  await expect.poll(() => calls.filter(call => call.method === 'market.trigger').length).toBe(3);
  gate.reject(rejected());
  await expect(page.locator('#trigger-error')).toBeVisible();
  await expect(page.locator('#trigger-status')).toContainText('Analysis failed');
  await expect(page.locator('#trigger-run')).toBeEnabled();
  assert.deepEqual(errors, []);
});

test('legacy default archive offers MSFT without claiming it is saved or downloading on navigation', async t => {
  const { page, calls, errors } = await open(t, { saved: snapshot(['SPY', 'QQQ', 'IWM']) });
  await page.locator('#rail-sources').click();
  await expect(page.locator('#research-symbols')).toHaveValue('SPY, QQQ, IWM, MSFT');
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(3);
  assert.equal(calls.filter(call => call.method === 'market.fetch').length, 0);
  await page.locator('#research-fetch').click();
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(4);
  assert.deepEqual(calls.find(call => call.method === 'market.fetch').params.symbols, ['SPY', 'QQQ', 'IWM', 'MSFT']);
  await page.reload();
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
  await page.locator('#rail-sources').click();
  await expect(page.locator('#research-symbols')).toHaveValue('SPY, QQQ, IWM, MSFT');
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(4);
  assert.deepEqual(errors, []);
});

test('default assets include MSFT and populate both allocation modes after explicit download', async t => {
  const { page, calls, errors } = await open(t, { saved: null, now: '2026-09-11T12:00:00' });
  await page.locator('#rail-sources').click();
  await expect(page.locator('#research-symbols')).toHaveValue('SPY, QQQ, IWM, MSFT');
  await expect(page.locator('#assets-start')).toHaveValue('2021-09-11');
  await expect(page.locator('#assets-end')).toHaveValue('2026-09-11');
  assert.equal(calls.length, 1, 'opening Assets must not fetch automatically');
  await page.locator('#research-fetch').click();
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(4);
  assert.deepEqual(calls.find(call => call.method === 'market.fetch').params.symbols, ['SPY', 'QQQ', 'IWM', 'MSFT']);
  await page.locator('#nav-backtest').click();
  for (const mode of ['portfolio', 'dynamic']) {
    await page.locator(`#backtest-tab-${mode}`).click();
    await expect(page.locator('#portfolio-weight-MSFT')).toHaveValue('0.25');
  }
  await page.locator('#nav-markets').click();
  await expect(page.locator('[data-testid="watch-MSFT"]')).toContainText('Microsoft');
  assert.deepEqual(errors, []);
});

test('empty archive, loading and failed downloads have visible guidance without hidden default fetches', async t => {
  const gate = deferred();
  const { page, calls, errors } = await open(t, { saved: null, fetch: () => gate.promise });
  await events(page);
  await expect(page.locator('#trigger-run')).toBeDisabled();
  await expect(page.locator('#trigger-disabled-reason')).toContainText('No saved archive');
  await page.locator('#nav-markets').click();
  await page.locator('#empty-fetch').click();
  await expect(page.locator('#assets-workspace')).toBeVisible();
  assert.equal(calls.length, 1);
  await page.locator('#research-symbols').fill('TLT, GLD');
  await page.locator('#research-fetch').click();
  await expect(page.locator('#research-fetch')).toBeDisabled();
  await expect(page.locator('#research-source')).toContainText('Fetching');
  gate.reject(rejected());
  await expect(page.locator('#assets-error')).toContainText('not retried automatically');
  await expect(page.locator('#research-fetch')).toBeEnabled();
  await expect(page.locator('#research-symbols')).toHaveValue('TLT, GLD');
  await expect(page.locator('#assets-table')).toContainText('No records returned');
  assert.equal(calls.filter(call => call.method === 'market.fetch').length, 1);
  assert.deepEqual(errors, []);
});

test('same-archive verification preserves manual dates; replaced archive discards pending event response', async t => {
  let gate;
  const { page, calls, errors } = await open(t, { trigger: () => (gate = deferred()).promise });
  await events(page);
  await page.locator('#trigger-start').selectOption(dates[1]);
  await page.locator('#rail-sources').click();
  await page.locator('#assets-verify').click();
  await expect(page.locator('#research-source')).toContainText('Saved bytes verified');
  await events(page);
  await expect(page.locator('#trigger-start')).toHaveValue(dates[1]);
  await page.locator('#trigger-run').click();
  await expect.poll(() => calls.filter(call => call.method === 'market.trigger').length).toBe(1);
  const oldSpec = calls.at(-1).params.spec;
  await page.locator('#rail-sources').click();
  await page.locator('#research-symbols').fill('TLT, GLD, SPY, QQQ');
  await page.locator('#research-fetch').click();
  await expect(page.locator('#assets-table tbody tr')).toHaveCount(4);
  gate.resolve(resultFor(oldSpec));
  await events(page);
  await expect(page.locator('#trigger-run')).toBeEnabled();
  await expect(page.locator('#trigger-result')).toBeHidden();
  await expect(page.locator('#trigger-error')).toBeHidden();
  await expect(page.locator('#trigger-start')).toHaveValue(dates[0]);
  assert.deepEqual(errors, []);
});