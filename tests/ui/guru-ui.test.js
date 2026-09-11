// Standalone renderer contract tests. ALL data is labeled TEST ONLY synthetic
// fixture data; no server, production feed, market service or model is called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from './helpers/dependencies.js';
import { validateGuruRequest } from '../../ui/guru-service.js';

const period = '2026-06-30', historical = '2026-03-31';
const cik = index => String(index + 1).padStart(10, '0');
const envelope = data => ({ data, source: {
  provider: 'TEST ONLY provider', url: 'https://example.invalid/test-only', fetchedAt: '2026-09-11T00:00:00Z',
  cached: true, cacheAgeSeconds: 21, upstreamCacheAgeHours: 120, independentlyVerified: false,
}, limitations: ['TEST ONLY caveat: not actual fund returns.'] });
const fundRows = Array.from({ length: 87 }, (_, i) => ({
  cik: cik(i), name: `TEST ONLY fund ${String(i).padStart(2, '0')}`, manager: `TEST ONLY manager ${i}`,
  category: i % 2 ? 'PROVIDER_CATEGORY' : '그로스', category_en: i % 2 ? null : 'Growth',
  active: i < 83 ? 1 : 0, show_in_default: i < 79 || i >= 83 ? 1 : 0,
  return_start_period: '2020-12-31', return_end_period: period, latest_period: historical,
  reliability_label: i === 1 ? 'caution' : 'normal', quality_tag: 'TEST ONLY quality', returns_current: i !== 1,
  returns: { '1y_total': i === 0 ? null : i === 1 ? -5 : 23.8, '3y_annualized': null, '5y_annualized': -8.7, inception_annualized: 87 - i, yearly: { 2025: 1, 2026: 13.25 } },
}));
const fixtures = {
  'guru.funds': envelope({ funds: fundRows, note: 'TEST ONLY provider note <img src=x onerror=alert(1)>' }),
  'guru.quarters': envelope({ quarters: [{ period, fund_count: 76, not_filed_count: 3 }, { period: historical, fund_count: 77, not_filed_count: 2 }], default_period: period, total_visible_funds: 79 }),
  'guru.fund': envelope({ fund: fundRows[1], period, periods_available: [period, historical], latest_filed_period: period, latest_market_period: period,
    filing_status: 'filed', is_empty_filing: false, total_value: 197000, position_count: 197,
    return_start_period: '2020-12-31', return_end_period: period, returns_current: false, returns: fundRows[1].returns,
    holdings: Array.from({ length: 197 }, (_, i) => ({ cusip: `TEST${i}`, ticker: i === 0 ? null : i === 1 ? 'A.B' : `TEST${i}`, name: i === 1 ? '<img src=x onerror=alert(1)>' : `TEST ONLY company ${i}`, shares: i + 1, value: 197000 - i,
      pct_portfolio: i === 0 ? null : 7.5, change_type: i === 1 ? 'NEW' : 'INC', pct_change: i === 1 ? null : 2.5 })),
  }),
  'guru.popular': envelope({ period, manager_funds: [{ ticker: 'TEST', name: 'TEST ONLY popular', manager_count: 4, total_value: 1000, total_shares: 10, top_holders: [{ cik: cik(1), manager: 'TEST ONLY holder', fund: 'TEST ONLY fund', value: 123 }] }],
    filed_count: 76, not_filed_count: 3, fund_status: [{ cik: cik(1), manager: 'TEST ONLY manager', name: 'TEST ONLY coverage', filing_status: 'not_filed', latest_filed_period: historical, is_index: true, is_empty_filing: false, position_count: 10, total_value: 1000 }] }),
  'guru.changes': envelope({ period, filed_count: 76, not_filed_count: 3,
    fund_status: [{ cik: cik(1), name: 'TEST ONLY coverage', filing_status: 'not_filed', is_index: false }],
    changes: Array.from({ length: 100 }, (_, i) => ({ cik: cik(1), fund_name: 'TEST ONLY fund', manager: 'TEST ONLY manager', period,
      cusip: `TEST${i}`, ticker: `TEST${i}`, name: 'TEST ONLY changed company', change_type: ['NEW', 'INC', 'DEC', 'SOLD'][i % 4], prev_shares: i, new_shares: i + 1, pct_change: i === 0 ? null : 3.5, value: 1000 })),
  }),
};

test('Guru standalone dashboard uses only the injected, validated API', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const js = await readFile(new URL('../../ui/gui/guru.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../ui/gui/guru.css', import.meta.url), 'utf8');
  const hostCss = await readFile(new URL('../../ui/gui/style.css', import.meta.url), 'utf8');
  const pages = [];
  async function mount(overrides = {}) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.setContent('<!doctype html><html lang="en"><body><main id="test-guru"></main></body></html>');
    await page.addStyleTag({ content: hostCss + css });
    await page.addScriptTag({ content: js });
    await page.evaluate(({ fixture, overrides }) => {
      window.fixture = { ...fixture, ...overrides };
      window.calls = []; window.failNext = ''; window.holdNext = ''; window.pending = [];
      const api = (method, params) => {
        window.calls.push({ method, params: structuredClone(params) });
        if (window.failNext === method) { window.failNext = ''; return Promise.reject(new Error('TEST ONLY failure')); }
        const response = structuredClone(window.fixture[method]);
        if (method === 'guru.fund') {
          response.data.fund = { ...window.fixture['guru.funds'].data.funds.find(f => f.cik === params.id) };
          response.data.period = params.period || response.data.period;
        }
        if (method === 'guru.popular' || method === 'guru.changes') response.data.period = params.period;
        if (method === 'guru.popular' && response.data.manager_funds[0]) response.data.manager_funds[0].name = `TEST ONLY ${params.mode}`;
        if (window.holdNext === method) {
          window.holdNext = '';
          return new Promise((resolve, reject) => window.pending.push({ resolve: () => resolve(response), reject: () => reject(new Error('TEST ONLY stale failure')) }));
        }
        return Promise.resolve(response);
      };
      window.guru = window.ITTGuru({ root: document.querySelector('#test-guru'), api });
    }, { fixture: fixtures, overrides });
    pages.push({ page, errors, requests }); return page;
  }
  const show = async page => { await page.evaluate(() => window.guru.show()); await expect(page.locator('#guru-status')).toHaveText('Loaded.'); };
  const calls = page => page.evaluate(() => window.calls);
  const last = async page => (await calls(page)).at(-1);

  await t.test('init is inert, automatic first show requests both endpoints, 79/87 default and local filtering/paging', async () => {
    const page = await mount();
    assert.deepEqual(await calls(page), []);
    await expect(page.locator('#test-guru')).toBeHidden();
    await show(page);
    assert.deepEqual(await calls(page), [{ method: 'guru.funds', params: {} }, { method: 'guru.quarters', params: {} }]);
    await expect(page.locator('.guru-summary')).toContainText('79 default active funds / 87 total');
    await expect(page.locator('#guru-funds-table tbody tr')).toHaveCount(30);
    await page.locator('#guru-funds-page-size').selectOption('50');
    await expect(page.locator('#guru-funds-table tbody tr')).toHaveCount(50);
    await page.locator('.guru-pagination').getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('#guru-funds-table tbody tr')).toHaveCount(29);
    await page.locator('#guru-universe').selectOption('all');
    await expect(page.locator('.guru-pagination')).toContainText('87 records');
    await page.locator('#guru-universe').selectOption('active');
    await expect(page.locator('.guru-pagination')).toContainText('83 records');
    await page.locator('#guru-style').selectOption('Growth');
    await expect(page.locator('#guru-funds-table')).not.toContainText('PROVIDER_CATEGORY');
    await page.locator('#guru-fund-search').fill('TEST ONLY fund 02');
    await expect(page.locator('#guru-funds-table tbody tr')).toHaveCount(1);
    await page.locator('#guru-fund-search').fill('.*');
    await expect(page.locator('#guru-funds-table')).toContainText('No matching records.');
    assert.equal((await calls(page)).length, 2);
    await expect(page.locator('#guru-caveats')).not.toHaveAttribute('open');
    await expect(page.locator('#guru-estimate-warning')).toBeVisible();
    await expect(page.locator('#guru-provenance')).toContainText('Fetched: 2026-09-11T00:00:00Z · Local cache: yes · Cache age: 21 s');
    assert.equal(await page.locator('#test-guru input[type=file]').count(), 0);
  });

  await t.test('keyboard sorting keeps null last in both directions and preserves percent units', async () => {
    const page = await mount(); await show(page);
    const sort = page.locator('[data-sort="1y"]');
    await sort.focus(); await page.keyboard.press('Enter');
    await expect(sort.locator('..')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('#guru-funds-table tbody tr').first()).toContainText('-5%');
    await expect(page.locator('#guru-funds-table')).toContainText('23.8%');
    await expect(page.locator('#guru-funds-table')).not.toContainText('2,380%');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-sort="1y"]').locator('..')).toHaveAttribute('aria-sort', 'descending');
    await expect(page.locator('#guru-funds-table tbody tr').first()).toContainText('23.8%');
    await page.locator('#guru-funds-page-size').selectOption('50');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('#guru-funds-table tbody tr').last()).toContainText('TEST ONLY fund 00');
    await expect(page.locator('#guru-funds-table tbody tr').last()).toContainText('13.25%');
  });

  await t.test('fund detail separates historical holdings and return periods, uses actual keys and bounded holdings', async () => {
    const page = await mount(); await show(page);
    await page.locator(`[data-fund-id="${cik(1)}"]`).click();
    await expect(page.locator('#guru-holdings-table')).toBeVisible();
    assert.deepEqual(await last(page), { method: 'guru.fund', params: { id: cik(1) } });
    await expect(page.locator('#guru-holdings-table tbody tr')).toHaveCount(30);
    await expect(page.locator('#guru-performance')).toContainText('Returns current: false');
    await page.locator('#guru-detail-quarter').selectOption(historical);
    await expect(page.locator('#guru-holdings-table caption')).toContainText(historical);
    assert.deepEqual(await last(page), { method: 'guru.fund', params: { id: cik(1), period: historical } });
    await expect(page.locator('#guru-detail-summary')).toContainText(`Holdings as of: ${historical}`);
    await expect(page.locator('#guru-performance')).toContainText(`Return coverage: 2020-12-31 → ${period}`);
    await expect(page.locator('#guru-performance')).toContainText('13.25%');
    await expect(page.locator('#guru-holdings-bars meter')).toHaveCount(10);
    assert.equal(await page.locator('#guru-holdings-bars meter').first().getAttribute('value'), '7.5');
    await page.locator('#guru-holdings-search').fill('A.B');
    await expect(page.locator('#guru-holdings-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#guru-holdings-table')).toContainText('<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('#test-guru img').count(), 0);
    await expect(page.locator('#guru-holdings-table tbody tr')).toContainText('New');
    await expect(page.locator('#guru-holdings-table tbody tr td').last()).toHaveText('—');
    await page.locator('#guru-refresh').click();
    await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    assert.deepEqual(await last(page), { method: 'guru.fund', params: { id: cik(1), period: historical, refresh: true } });
  });

  await t.test('popular modes, index and quarter filters use exact endpoint shapes', async () => {
    const page = await mount(); await show(page); await page.locator('#guru-tab-popular').click();
    await expect(page.locator('#guru-popular-table')).toContainText('TEST ONLY popular');
    for (const mode of ['buys', 'sells', 'popular']) {
      await page.locator('#guru-popular-mode').selectOption(mode);
      await expect(page.locator('#guru-popular-table')).toContainText(`TEST ONLY ${mode}`);
      assert.deepEqual(await last(page), { method: 'guru.popular', params: { period, include_index: false, limit: 30, mode } });
    }
    await page.locator('#guru-include-index').check(); await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    await page.locator('#guru-quarter').selectOption(historical); await expect(page.locator('#guru-popular-table caption')).toContainText(historical);
    assert.deepEqual(await last(page), { method: 'guru.popular', params: { period: historical, include_index: true, limit: 30, mode: 'popular' } });
    await expect(page.locator('#guru-filed-counts')).toContainText('Filed: 76 · Not filed: 3');
    await page.locator('#guru-filing-status summary').click();
    await expect(page.locator('#guru-filing-table')).toContainText('not_filed');
    await expect(page.locator('#guru-popular-table')).toContainText('TEST ONLY holder');
  });

  await t.test('recent changes type/fund/index/quarter filters, filed status and local paging', async () => {
    const page = await mount(); await show(page); await page.locator('#guru-tab-changes').click();
    await expect(page.locator('#guru-changes-table tbody tr')).toHaveCount(30);
    for (const type of ['NEW', 'INC', 'DEC', 'SOLD', '']) {
      await page.locator('#guru-change-type').selectOption(type); await expect(page.locator('#guru-status')).toHaveText('Loaded.');
      assert.deepEqual((await last(page)).params, { period, include_index: false, limit: 200, ...(type ? { type } : {}) });
    }
    await page.locator('#guru-change-fund').selectOption(cik(1)); await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    await page.locator('#guru-include-index').check(); await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    await page.locator('#guru-quarter').selectOption(historical); await expect(page.locator('#guru-changes-table caption')).toContainText(historical);
    assert.deepEqual((await last(page)).params, { period: historical, include_index: true, limit: 200, cik: cik(1) });
    await page.locator('#guru-changes-page-size').selectOption('50');
    await expect(page.locator('#guru-changes-table tbody tr')).toHaveCount(50);
    const count = (await calls(page)).length;
    await page.locator('#guru-changes-search').fill('TEST99');
    await expect(page.locator('#guru-changes-table tbody tr')).toHaveCount(1);
    assert.equal((await calls(page)).length, count);
    await expect(page.locator('#guru-filed-counts')).toContainText('Not filed: 3');
  });

  await t.test('errors expose retry; explicit overview refresh refreshes both bootstrap endpoints', async () => {
    const page = await mount();
    await page.evaluate(() => { window.failNext = 'guru.funds'; });
    await page.evaluate(() => window.guru.show());
    await expect(page.locator('#guru-retry')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('TEST ONLY failure');
    await page.locator('#guru-retry').click(); await expect(page.locator('#guru-funds-table')).toBeVisible();
    await page.locator('#guru-refresh').click(); await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    assert.deepEqual((await calls(page)).slice(-2), [{ method: 'guru.funds', params: { refresh: true } }, { method: 'guru.quarters', params: { refresh: true } }]);
    await page.evaluate(() => { window.failNext = 'guru.popular'; });
    await page.locator('#guru-tab-popular').click(); await expect(page.locator('#guru-retry')).toBeVisible();
    await expect(page.locator('#guru-funds-table')).toHaveCount(0);
    await page.locator('#guru-retry').click(); await expect(page.locator('#guru-popular-table')).toBeVisible();
  });

  await t.test('newer requests and hide prevent stale success/error rendering, including bootstrap', async () => {
    const page = await mount();
    await page.evaluate(() => { window.holdNext = 'guru.funds'; void window.guru.show(); });
    await expect(page.locator('#guru-panel')).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => { window.guru.hide(); });
    await show(page);
    await page.evaluate(() => { window.pending.shift().reject(); });
    await expect(page.locator('#guru-funds-table')).toBeVisible();
    await page.evaluate(() => { window.holdNext = 'guru.popular'; });
    await page.locator('#guru-tab-popular').click();
    await expect(page.locator('#guru-status')).toContainText('Loading');
    await page.locator('#guru-popular-mode').selectOption('buys');
    await expect(page.locator('#guru-popular-table')).toContainText('TEST ONLY buys');
    await page.evaluate(() => { window.pending.shift().resolve(); });
    await expect(page.locator('#guru-popular-table')).toContainText('TEST ONLY buys');
    await page.evaluate(() => { window.holdNext = 'guru.popular'; });
    await page.locator('#guru-popular-mode').selectOption('sells');
    await page.evaluate(() => { window.guru.hide(); });
    const before = await page.locator('#test-guru').textContent();
    await page.evaluate(async () => { window.pending.shift().resolve(); await Promise.resolve(); });
    assert.equal(await page.locator('#test-guru').textContent(), before);
    await expect(page.locator('#test-guru')).toBeHidden();
    await show(page); await expect(page.locator('#guru-popular-table')).toContainText('TEST ONLY sells');
    await page.locator('#guru-tab-popular').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#guru-tab-changes')).toHaveAttribute('aria-selected', 'true');
  });

  await t.test('quarters/detail/changes failures retry without automatic loops or stale detail quarters', async () => {
    const page = await mount();
    await page.evaluate(() => { window.failNext = 'guru.quarters'; });
    await page.evaluate(() => window.guru.show());
    await expect(page.locator('#guru-retry')).toBeVisible();
    assert.equal((await calls(page)).length, 2);
    await page.locator('#guru-retry').click(); await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    for (const [view, method, table] of [['detail', 'guru.fund', 'holdings'], ['changes', 'guru.changes', 'changes']]) {
      await page.evaluate(method => { window.failNext = method; }, method);
      await page.locator(`#guru-tab-${view}`).click();
      await expect(page.locator('#guru-retry')).toBeVisible();
      const count = (await calls(page)).length;
      await page.locator('#guru-retry').click();
      await expect(page.locator(`#guru-${table}-table`)).toBeVisible();
      assert.equal((await calls(page)).length, count + 1);
    }
    await page.locator('#guru-tab-detail').click(); await expect(page.locator('#guru-detail-quarter')).toBeVisible();
    await page.evaluate(() => { window.holdNext = 'guru.fund'; });
    await page.locator('#guru-detail-fund').selectOption(cik(2));
    await expect(page.locator('#guru-detail-quarter')).toHaveCount(0);
    await page.locator('#guru-detail-fund').selectOption(cik(3));
    await expect(page.locator('#guru-results h3').first()).toContainText('TEST ONLY fund 03');
    await page.evaluate(() => { window.pending.shift().resolve(); });
    await expect(page.locator('#guru-results h3').first()).toContainText('TEST ONLY fund 03');
  });

  await t.test('scoped theme and narrow layout keep wide tables inside their scrolling surface', async () => {
    const page = await mount(); await show(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => {
      const root = document.querySelector('#test-guru');
      const scroll = document.querySelector('.guru-table-scroll');
      return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        overflow: getComputedStyle(scroll).overflowX, color: getComputedStyle(root).color,
        family: getComputedStyle(root).fontFamily };
    });
    assert.equal(layout.pageWidth, layout.viewport);
    assert.equal(layout.overflow, 'auto');
    assert.match(layout.family, /Segoe UI/);
    const dark = await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      return getComputedStyle(document.querySelector('#test-guru')).color;
    });
    assert.notEqual(dark, layout.color);
  });

  await t.test('empty data and unsafe provenance never invent data or links', async () => {
    const emptyFunds = envelope({ funds: [], note: '<script>throw 1</script>' }); emptyFunds.source.url = 'javascript:alert(1)';
    const page = await mount({ 'guru.funds': emptyFunds, 'guru.quarters': envelope({ quarters: [], default_period: null }) });
    await show(page);
    await expect(page.locator('#guru-funds-table')).toContainText('No matching records.');
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await page.locator('#guru-tab-detail').click(); await expect(page.locator('#guru-results')).toContainText('No funds available.');
    await page.locator('#guru-tab-popular').click(); await expect(page.locator('#guru-results')).toContainText('No reporting quarters available.');
    assert.equal((await calls(page)).length, 2);
    const detail = structuredClone(fixtures['guru.fund']); detail.data.returns = null; detail.data.holdings = []; detail.data.is_empty_filing = true;
    const other = await mount({ 'guru.fund': detail, 'guru.popular': envelope({ period, manager_funds: [] }), 'guru.changes': envelope({ period, changes: [], fund_status: [] }) });
    await show(other); await other.locator('#guru-tab-detail').click();
    await expect(other.locator('#guru-holdings-table')).toContainText('No matching records.');
    await expect(other.locator('#guru-holdings-bars')).toContainText('No chart generated.');
    await expect(other.locator('#guru-performance dd')).toHaveText(['—', '—', '—', '—', '—']);
    await other.locator('#guru-tab-popular').click(); await expect(other.locator('#guru-popular-table')).toContainText('No matching records.');
    await other.locator('#guru-tab-changes').click(); await expect(other.locator('#guru-changes-table')).toContainText('No matching records.');
  });

  // Check every exercised wire shape against the real adapter validator.
  for (const { page, errors, requests } of pages) {
    for (const call of await calls(page)) assert.doesNotThrow(() => validateGuruRequest(call.method, call.params));
    assert.deepEqual(errors, []); assert.deepEqual(requests, [], 'standalone suite must never access a network');
    await page.close();
  }
  assert.doesNotMatch(js, /innerHTML|fetch\(|XMLHttpRequest|market\.guru|type\s*=\s*['"]file['"]/);
});