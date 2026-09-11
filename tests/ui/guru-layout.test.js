// Production HTTP host and assets, TEST ONLY reference data. No live feed,
// saved-market writes, Python process or model calls. Evidence is unique per run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const period = '2026-06-30', historical = '2026-03-31';
const funds = Array.from({ length: 35 }, (_, i) => ({
  cik: String(i + 1).padStart(10, '0'), name: `TEST ONLY Fund ${i}`, manager: `TEST ONLY Manager ${i}`,
  category_en: i % 2 ? 'Growth' : 'Value', active: true, show_in_default: i < 33,
  return_start_period: '2020-12-31', return_end_period: period, latest_period: historical,
  reliability_label: 'normal', quality_tag: 'TEST ONLY', returns_current: false,
  returns: { '1y_total': 23.8, '3y_annualized': null, '5y_annualized': -8.7, inception_annualized: 12.5, yearly: { 2026: 13.25 } },
}));
const envelope = data => ({ data, source: { provider: 'TEST ONLY reference fixture', url: 'https://example.invalid/test-only',
  fetchedAt: '2026-09-11T00:00:00Z', cached: false, cacheAgeSeconds: 0, upstreamCacheAgeHours: 12,
  independentlyVerified: false }, limitations: ['TEST ONLY synthetic UI evidence; not live or independently verified financial data.'] });

function fixture(method, params) {
  const selected = params.period || period;
  const fund = funds.find(f => f.cik === params.id) || funds[0];
  const coverage = { period: selected, filed_count: 33, not_filed_count: 2,
    fund_status: [{ ...funds[0], filing_status: 'not_filed', latest_filed_period: historical, position_count: 35, total_value: 350000 }] };
  if (method === 'guru.funds') return envelope({ funds });
  if (method === 'guru.quarters') return envelope({ quarters: [{ period }, { period: historical }], default_period: period });
  if (method === 'guru.fund') return envelope({ fund, period: selected, periods_available: [period, historical],
    latest_filed_period: period, latest_market_period: period, filing_status: 'filed', is_empty_filing: false,
    total_value: 350000, position_count: 35, return_start_period: fund.return_start_period, return_end_period: period,
    returns_current: false, returns: fund.returns,
    holdings: Array.from({ length: 35 }, (_, i) => ({ ticker: `TEST${i}`, name: `TEST ONLY Company ${i}`,
      value: 350000 - i, shares: 1000, pct_portfolio: 7.5, change_type: 'INC', pct_change: 2.5 })) });
  if (method === 'guru.popular') return envelope({ ...coverage, manager_funds: Array.from({ length: 12 }, (_, i) => ({
    ticker: `TEST${i}`, name: `TEST ONLY ${params.mode} ${i}`, manager_count: 4, total_value: 10000, total_shares: 100,
    top_holders: [{ cik: funds[0].cik, manager: funds[0].manager, fund: funds[0].name, value: 1234 }],
  })) });
  if (method === 'guru.changes') return envelope({ ...coverage, changes: Array.from({ length: 35 }, (_, i) => ({
    cik: params.cik || funds[0].cik, manager: funds[0].manager, fund_name: funds[0].name, period: selected,
    ticker: `TEST${i}`, name: `TEST ONLY Company ${i}`, change_type: params.type || 'INC',
    prev_shares: 100, new_shares: 103, pct_change: 3, value: 1234,
  })) });
  throw new Error(`Unexpected Guru method: ${method}`);
}

test('expanded Guru production host: viewport-filling tables and preserved controls', async t => {
  const parent = path.join(process.env.ITT_TEST_OUTPUT_DIR || path.join(root, 'output'), 'guru-verification/layout-runs');
  await fs.mkdir(parent, { recursive: true });
  const output = await fs.mkdtemp(path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  const report = { fixture: 'TEST ONLY', liveFetch: false, layouts: [], screenshots: [], calls: [], errors: [], external: [], forbidden: [] };
  const deny = method => { report.forbidden.push(method); throw new Error(`Prohibited: ${method}`); };
  const app = await startGUI({ backend: { on() {}, async close() {}, async request(method) {
    if (method !== 'market.show') return deny(method);
    throw new Error('TEST ONLY layout run: saved market intentionally unavailable');
  } }, guru: { async request(method, params) { report.calls.push({ method, params }); return fixture(method, params); } },
  copilot: { status: () => deny('copilot.status'), analyze: () => deny('copilot.analyze'), criteria: () => deny('copilot.criteria'), async close() {} } });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  t.after(async () => {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(`Guru layout evidence: ${path.relative(root, output).replaceAll('\\', '/')}`);
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === app.origin) return route.continue();
    report.external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const loaded = async () => { await expect(page.locator('#guru-status')).toHaveText('Loaded.'); };
  async function capture(view, table, viewport) {
    await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('main, .research-workspace, .guru-table-scroll')) el.scrollTo(0, 0); });
    const layout = await page.locator(`#guru-${table}-table tbody tr`).first().evaluate(row => {
      const r = row.getBoundingClientRect();
      const surface = row.closest('.guru-table-scroll');
      const surfaceRect = surface.getBoundingClientRect();
      const header = surface.querySelector('thead').getBoundingClientRect();
      const host = document.querySelector('#research-workspace').getBoundingClientRect();
      const visibleBottom = Math.min(surfaceRect.bottom, host.bottom, innerHeight);
      const pagination = surface.nextElementSibling.getBoundingClientRect();
      const warning = document.querySelector('#guru-estimate-warning').getBoundingClientRect();
      const fields = [...document.querySelectorAll('#guru-controls input, #guru-controls select')].map(el => {
        const b = el.getBoundingClientRect(); return { id: el.id, left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      });
      return { top: r.top, bottom: r.bottom, viewportHeight: innerHeight, viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
        surface: { top: surfaceRect.top, bottom: surfaceRect.bottom, height: surfaceRect.height,
          clientWidth: surface.clientWidth, scrollWidth: surface.scrollWidth,
          visibleDataHeight: visibleBottom - r.top,
          visibleRows: [...surface.querySelectorAll('tbody tr')].filter(el => el.getBoundingClientRect().bottom <= visibleBottom).length },
        headerHeight: header.height,
        hostBottom: host.bottom, paginationBottom: pagination.bottom,
        clippedCells: [...surface.querySelectorAll('td, th button')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent),
        minFont: Math.min(...[...surface.querySelectorAll('td, td small, th button')].map(el => parseFloat(getComputedStyle(el).fontSize))),
        warning: { top: warning.top, bottom: warning.bottom }, fields,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--cp-accent').trim() };
    });
    const name = `${view}-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: path.join(output, name) });
    report.screenshots.push(name); report.layouts.push({ view, ...layout });
    assert.ok(layout.top < viewport.height / 2, `${name}: first data row top ${layout.top} >= ${viewport.height / 2}`);
    assert.ok(layout.top <= (viewport.width >= 1000 ? 280 : 360), `${name}: first row starts too low at ${layout.top}`);
    assert.ok(layout.paginationBottom <= layout.hostBottom, `${name}: pagination must remain inside the host`);
    assert.deepEqual(layout.clippedCells, [], `${name}: no clipped cell content`);
    assert.ok(layout.minFont >= 12, `${name}: table text must be at least 12px`);
    if (table === 'funds') {
      assert.ok(layout.surface.visibleDataHeight >= (viewport.width >= 1000 ? viewport.height - 340 : 580), `${name}: table must use the available height`);
      if (viewport.width >= 1000) assert.equal(layout.surface.scrollWidth, layout.surface.clientWidth, 'All nine overview columns fit desktop without horizontal scrolling');
      await expect(page.locator('#guru-funds-table th')).toHaveCount(9);
      await expect(page.locator('#guru-funds-table tbody tr').first().locator('.guru-number')).toHaveText(['13.25%', '23.8%', '—', '-8.7%', '12.5%']);
    }
    assert.ok(layout.bottom < viewport.height, `${name}: first row must be visible`);
    assert.ok(layout.documentWidth <= viewport.width && layout.bodyWidth <= viewport.width, `${name}: page horizontal overflow`);
    assert.ok(layout.warning.top >= 0 && layout.warning.bottom < viewport.height / 2, 'Estimate/delayed 13F warning stays visible');
    assert.ok(layout.fields.every(b => b.left >= 0 && b.right <= viewport.width && b.bottom < layout.top), 'All filters fit above the data');
    await expect(page.locator('#copilot-panel')).toBeHidden();
    await expect(page.locator('#guru-caveats')).not.toHaveAttribute('open');
    const pinned = await page.locator(`#guru-${table}-table`).evaluate(table => {
      const surface = table.parentElement;
      surface.scrollTop = 220;
      return new Promise(resolve => requestAnimationFrame(() => {
        const delta = table.querySelector('th').getBoundingClientRect().top - surface.getBoundingClientRect().top;
        const scrolled = surface.scrollTop;
        surface.scrollTop = 0;
        resolve({ delta, scrolled });
      }));
    });
    if (pinned.scrolled > 0) assert.ok(Math.abs(pinned.delta - 1) <= 1, `${name}: header stays pinned while table scrolls`);
  }
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 800, height: 1000 }]) {
    await page.setViewportSize(viewport);
    // Reload real production assets before measuring; no injected CSS or DOM fixtures.
    await page.goto(app.url);
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'error');
    await page.locator('#nav-research').click(); await page.locator('#research-tab-guru').click(); await loaded();
    for (const [view, table] of [['overview', 'funds'], ['popular', 'popular'], ['changes', 'changes'], ['detail', 'holdings']]) {
      await page.locator(`#guru-tab-${view}`).click(); await loaded();
      await t.test(`${view} ${viewport.width}x${viewport.height}`, () => capture(view, table, viewport));
    }
    assert.ok(await page.evaluate(() => document.querySelector('#guru-holdings-table').getBoundingClientRect().top < document.querySelector('#guru-detail-summary').getBoundingClientRect().top));
    await expect(page.locator('#guru-performance')).toBeVisible();
    await expect(page.locator('#guru-holdings-bars meter')).toHaveCount(10);
    await expect(page.locator('#guru-performance > .guru-metrics dd')).toHaveText(['13.25%', '23.8%', '—', '-8.7%', '12.5%']);
  }

  // Resize the already-mounted view without a reload or another provider call.
  await page.locator('#guru-tab-overview').click(); await loaded();
  const beforeResize = report.calls.length;
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.locator('#guru-funds-table').evaluate(table => {
      const surface = table.parentElement;
      const bottom = surface.nextElementSibling.getBoundingClientRect().bottom;
      const hostBottom = document.querySelector('#research-workspace').getBoundingClientRect().bottom;
      return Math.abs(hostBottom - bottom);
    })).toBeLessThan(12);
    await capture('overview-resized', 'funds', viewport);
  }
  assert.equal(report.calls.length, beforeResize, 'Viewport resize is layout-only');
  assert.ok(report.layouts.find(l => l.view === 'overview-resized' && l.viewportWidth === 1920).surface.height > 640, 'Tall viewports are no longer capped at 640px');
  await page.setViewportSize({ width: 800, height: 1000 });

  // Keyboard tab navigation and sort focus survive table redraws.
  await page.locator('#guru-tab-detail').focus(); await page.keyboard.press('Home'); await loaded();
  await expect(page.locator('#guru-tab-overview')).toBeFocused();
  const count = report.calls.length;
  await page.locator('#guru-universe').selectOption('all'); await page.locator('#guru-style').selectOption('Growth');
  await page.locator('#guru-fund-search').fill('Fund 1');
  await page.locator('#guru-funds-page-size').selectOption('50');
  const sort = page.locator('#guru-funds-table [data-sort="1y"]');
  await sort.focus(); await page.keyboard.press('Enter'); await expect(sort).toBeFocused();
  await expect(sort.locator('..')).toHaveAttribute('aria-sort', 'ascending');
  assert.equal(report.calls.length, count, 'Overview filtering and sorting are local');
  await page.locator('#guru-tab-overview').focus(); await page.keyboard.press('ArrowRight'); await loaded();
  await expect(page.locator('#guru-tab-detail')).toBeFocused();
  await page.locator('#guru-detail-fund').selectOption(funds[1].cik); await loaded();
  await page.locator('#guru-detail-quarter').selectOption(historical); await loaded();
  await page.locator('#guru-holdings-search').fill('TEST1');
  await page.locator('#guru-refresh').click(); await loaded();
  await expect(page.locator('#guru-detail-fund')).toHaveValue(funds[1].cik);
  await expect(page.locator('#guru-detail-quarter')).toHaveValue(historical);
  await expect(page.locator('#guru-holdings-search')).toHaveValue('TEST1');
  assert.deepEqual(report.calls.at(-1), { method: 'guru.fund', params: { id: funds[1].cik, period: historical, refresh: true } });
  await expect(page.locator('#guru-detail-summary')).toContainText(`Holdings as of: ${historical}`);
  await expect(page.locator('#guru-performance')).toContainText(`Return coverage: 2020-12-31 → ${period}`);
  await page.locator('#guru-tab-overview').click(); await loaded();
  await expect(page.locator('#guru-fund-search')).toHaveValue('Fund 1');
  await expect(page.locator('#guru-universe')).toHaveValue('all');
  await expect(page.locator('#guru-style')).toHaveValue('Growth');
  await expect(page.locator('#guru-funds-page-size')).toHaveValue('50');
  await page.locator('#guru-tab-popular').click(); await loaded();
  await page.locator('#guru-quarter').selectOption(historical); await loaded();
  await page.locator('#guru-include-index').check(); await loaded();
  await page.locator('#guru-popular-mode').selectOption('buys'); await loaded();
  await page.locator('#guru-popular-search').fill('TEST1');
  await page.locator('#guru-tab-changes').click(); await loaded();
  await expect(page.locator('#guru-quarter')).toHaveValue(historical);
  await expect(page.locator('#guru-include-index')).toBeChecked();
  await page.locator('#guru-change-type').selectOption('NEW'); await loaded();
  await page.locator('#guru-change-fund').selectOption(funds[1].cik); await loaded();
  await page.locator('#guru-changes-search').fill('TEST1');
  await page.locator('#guru-refresh').click(); await loaded();
  assert.deepEqual(report.calls.at(-1), { method: 'guru.changes', params: { period: historical, include_index: true, limit: 200, type: 'NEW', cik: funds[1].cik, refresh: true } });
  await expect(page.locator('#guru-changes-search')).toHaveValue('TEST1');
  await page.locator('#guru-filing-status summary').click();
  await expect(page.locator('#guru-filing-table')).toBeVisible();
  await page.locator('#guru-tab-popular').click(); await loaded();
  await expect(page.locator('#guru-popular-mode')).toHaveValue('buys');
  await expect(page.locator('#guru-popular-search')).toHaveValue('TEST1');
  await page.locator('#guru-caveats summary').click();
  await expect(page.locator('#guru-caveats')).toContainText('Delayed 13F snapshots omit intraperiod trades and parts of the portfolio.');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
  report.interactionsPassed = true;
});