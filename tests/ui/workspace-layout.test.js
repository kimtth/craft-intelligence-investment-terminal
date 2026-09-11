// Production HTML/CSS/controllers and authenticated startGUI transport. Every
// financial value below is TEST ONLY synthetic layout data, never a live feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

const period = '2026-06-30';
const funds = Array.from({ length: 79 }, (_, i) => ({
  cik: String(i + 1).padStart(10, '0'), name: `TEST ONLY fund ${i}`, manager: `TEST ONLY manager ${i}`,
  active: 1, show_in_default: 1, category_en: 'TEST ONLY style', latest_period: period,
  return_start_period: '2020-12-31', return_end_period: period, returns_current: false,
  returns: { inception_annualized: 79 - i, '1y_total': null, yearly: {} },
}));
const envelope = data => ({ data, source: {
  provider: 'TEST ONLY injected reference feed', url: 'https://example.invalid/test-only',
  fetchedAt: '2026-09-11T00:00:00Z', cached: false, independentlyVerified: false,
}, limitations: ['TEST ONLY synthetic layout fixture. No real holdings or performance.'] });
const snapshot = {
  manifest: { id: '77777777-7777-4777-8777-777777777777', provider: 'Yahoo Finance', kind: 'real_market_snapshot', raw_sha256: {}, request_urls: {} }, summary: [],
  symbols: ['SPY', 'QQQ'].map(symbol => ({ symbol, currency: 'USD', bars: [
    { date: '2026-01-02', timestamp: 1767358800, open: '100', high: '102', low: '99', close: '101', volume: '1000' },
    { date: '2026-01-05', timestamp: 1767618000, open: '101', high: '103', low: '100', close: '102', volume: '1100' },
  ] })),
};

test('viewport host shows chat only in Markets, retains chat state and reclaims every other workspace (offline)', async t => {
  const calls = [], errors = [], external = [];
  let releaseMarket;
  const initialMarket = new Promise(resolve => { releaseMarket = resolve; });
  const forbidden = method => { calls.push(method); throw new Error(`TEST forbids ${method}`); };
  const app = await startGUI({
    backend: { on() {}, async close() {}, async request(method) {
      calls.push(method);
      assert.equal(method, 'market.show', 'only read-only mocked market data is permitted');
      await initialMarket;
      return structuredClone(snapshot);
    } },
    copilot: { async close() {}, status: () => forbidden('copilot.status'), analyze: () => forbidden('copilot.analyze'), criteria: () => forbidden('copilot.criteria') },
    guru: { async request(method, params) {
      calls.push(method);
      if (method === 'guru.funds') return envelope({ funds });
      if (method === 'guru.quarters') return envelope({ quarters: [{ period, fund_count: 79, not_filed_count: 0 }], default_period: period, total_visible_funds: 79 });
      assert.equal(method, 'guru.fund');
      return envelope({ fund: funds.find(f => f.cik === params.id), period, periods_available: [period],
        latest_filed_period: period, latest_market_period: period, filing_status: 'filed',
        total_value: 197000, position_count: 197, return_end_period: period,
        holdings: Array.from({ length: 197 }, (_, i) => ({
          cusip: `TEST${i}`, ticker: `TEST${i}`, name: `TEST ONLY holding ${i}`,
          shares: i + 1, value: 197000 - i, pct_portfolio: 1, change_type: 'INC', pct_change: null,
        })),
      });
    } },
  });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === app.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  async function bounded(label) {
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return { width: innerWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight,
        overflowElements: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().bottom > innerHeight + 1).slice(0, 12).map(el => ({ tag: el.tagName, id: el.id, position: getComputedStyle(el).position, box: el.getBoundingClientRect().toJSON() })),
        documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
        chat: rect('#copilot-panel'), composer: rect('#copilot-question'), main: rect('#main'),
        marketsActive: !document.querySelector('#markets-view').hidden,
        chatHidden: document.querySelector('#copilot-panel').hidden,
        hiddenClass: document.querySelector('.app-shell').classList.contains('chat-hidden'),
        shell: rect('.app-shell'), rail: rect('.rail'), stage: rect('#swarm-stage'), swarm: rect('#swarm-view'),
        topControls: [...document.querySelectorAll('.topbar button, .topbar input')].filter(e => e.getClientRects().length).map(e => {
          const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }),
      };
    });
    assert.ok(geometry.documentHeight <= geometry.height + 1, `${label}: document overflow ${JSON.stringify(geometry)}`);
    assert.ok(Math.max(geometry.documentWidth, geometry.bodyWidth) <= geometry.width + 1, `${label}: no horizontal document overflow`);
    for (const name of geometry.marketsActive ? ['chat', 'composer', 'main'] : ['main']) {
      const r = geometry[name];
      assert.ok(r.height > 0 && r.top >= 0 && r.bottom <= geometry.height + 1 && r.left >= 0 && r.right <= geometry.width + 1, `${label}: ${name} fully in viewport ${JSON.stringify(r)}`);
    }
    assert.ok(geometry.topControls.every(r => r.left >= 0 && r.right <= geometry.width + 1 && r.top >= 0 && r.bottom <= geometry.height), `${label}: top controls fit`);
    assert.equal(geometry.chatHidden, !geometry.marketsActive, `${label}: Markets-only chat`);
    assert.equal(geometry.hiddenClass, !geometry.marketsActive, `${label}: workspace layout class`);
    if (!geometry.marketsActive) {
      await expect(page.locator('#copilot-panel')).toBeHidden();
      assert.equal(geometry.chat.height, 0, `${label}: hidden chat occupies no space`);
      for (const [edge, expected] of Object.entries({ left: geometry.rail.right, right: geometry.shell.right, top: geometry.shell.top, bottom: geometry.shell.bottom })) {
        assert.ok(Math.abs(geometry.main[edge] - expected) <= 1, `${label}: main reclaims ${edge} bound: ${JSON.stringify(geometry)}`);
      }
    } else {
      await expect(page.locator('#copilot-panel')).toBeVisible();
      if (geometry.width <= 1200 || geometry.height <= 680) assert.equal(Math.round(geometry.chat.height), 220);
    }
    assert.equal(await page.evaluate(() => {
      const f = window.testOnlyChatFixture;
      return f.panel === document.querySelector('#copilot-panel') && f.question === document.querySelector('#copilot-question')
        && f.history === document.querySelector('#copilot-history') && f.entry === f.history.lastElementChild
        && f.history.innerHTML === f.html && f.question.value === f.draft;
    }), true, `${label}: same panel/composer/history/message nodes, history contents and unsent draft`);
    const beforeSettings = calls.length;
    await expect(page.locator('#nav-settings')).toBeInViewport();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('#settings-dialog #copilot-check')).toBeVisible();
    await expect(page.locator('#copilot-check')).toHaveCount(1);
    await expect(page.locator('#criteria-connect, #copilot-open-settings')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-settings')).toBeFocused();
    assert.equal(calls.length, beforeSettings, `${label}: Settings does not connect or make API calls`);
    return geometry;
  }
  async function reachable(selector, workspace) {
    const target = page.locator(selector);
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    assert.ok(await page.locator(workspace).evaluate(el => el.scrollHeight >= el.clientHeight), `${workspace}: content retained`);
    await bounded(selector);
  }
  const marketScope = async () => {
    await expect(page.locator('#scope-provider')).toHaveText('Yahoo Finance');
    await expect(page.locator('#scope-frequency')).toHaveText('Daily bars · saved coverage');
    await expect(page.locator('#scope-currency')).toHaveText('USD');
    await expect(page.locator('#scope-mode')).toHaveText('Local snapshot · read-only');
  };

  await page.goto(app.url);
  // Finish a market read while Guru is active: renderMarket/renderContext must
  // not leave market currency/location over the separately scoped workspace.
  await page.locator('#nav-research').click();
  await page.locator('#research-tab-guru').click();
  await expect(page.locator('#guru-status')).toHaveText('Loaded.');
  releaseMarket();
  await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
  await expect(page.locator('#workspace-location')).toHaveText('Research / Guru');

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 800, height: 1000 }, { width: 1440, height: 650 }]) {
    await t.test(`${viewport.width}×${viewport.height}: Guru, Swarm, Backtest, Research and Markets`, async () => {
      await page.setViewportSize(viewport);
      await page.reload(); // Assert current served styles, not a cached screenshot.
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
      await page.locator('#copilot-question').fill('TEST ONLY unsent draft across every workspace');
      // Explicit DOM history fixture, not a model response or private application state.
      await page.evaluate(() => {
        const panel = document.querySelector('#copilot-panel'), question = document.querySelector('#copilot-question');
        const history = document.querySelector('#copilot-history'), entry = document.createElement('article');
        entry.textContent = 'TEST ONLY retained history sentinel — no inference'; history.append(entry);
        window.testOnlyChatFixture = { panel, question, history, entry, html: history.innerHTML, draft: question.value };
      });
      await marketScope(); await bounded('Markets');
      await page.locator('#nav-research').click();
      await page.locator('#research-tab-guru').click();
      await expect(page.locator('#guru-status')).toHaveText('Loaded.');
      await expect(page.locator('#scope-provider')).toHaveText('easyinvesting.app');
      await expect(page.locator('#scope-frequency')).toHaveText('Quarterly 13F');
      await expect(page.locator('#scope-mode')).toHaveText('Automatic reference feed');
      await expect(page.locator('.workspace-why')).toBeHidden();
      await expect(page.locator('.research-data')).toBeHidden();
      await bounded('Guru overview');
      await page.locator('#source-top').click();
      await expect(page.locator('#source-title')).toHaveText('Saved Yahoo provenance');
      await page.locator('#close-sources').click();
      await reachable('#guru-funds-table tbody tr:last-child td:first-child', '#research-workspace');
      const pager = page.locator('.guru-pagination');
      await pager.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(pager).toContainText('79 records');
      await page.locator('#guru-funds-table [data-fund-id]').first().click();
      await expect(page.locator('#guru-holdings-table tbody tr')).toHaveCount(30);
      await reachable('#guru-holdings-table tbody tr:last-child td:first-child', '#research-workspace');
      const holdingsPager = page.locator('#guru-holdings-page-size').locator('xpath=ancestor::div[contains(@class,"guru-pagination")]');
      for (let i = 0; i < 6; i++) await holdingsPager.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.locator('#guru-holdings-table tbody tr')).toHaveCount(17);
      await reachable('#guru-holdings-table tbody tr:last-child td:first-child', '#research-workspace');
      await expect(page.locator('#guru-holdings-table')).toContainText('TEST196');

      const beforeSwarm = calls.length;
      await page.locator('#nav-swarm').click();
      await expect(page.locator('#scope-provider')).toHaveText('Simulated');
      await expect(page.locator('#scope-frequency')).toHaveText('Illustrative metrics');
      await expect(page.locator('#scope-currency')).toHaveText('No real trades');
      await expect(page.locator('#swarm-start')).toBeInViewport();
      await bounded('Swarm initial');
      assert.ok(await page.locator('#swarm-stage').evaluate(el => el.clientHeight <= document.querySelector('#swarm-view').clientHeight));
      // The exhaustive demo contract checks the four supported viewports without
      // scrolling. This legacy 650px host case still tests internal reachability.
      if (viewport.height >= 768) assert.ok(await page.locator('#swarm-stage').evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
      await page.locator('#swarm-start').click();
      await page.locator('#swarm-pause').click();
      for (let i = 0; i < 8; i++) await page.locator('#swarm-next').click();
      for (const agent of await page.locator('.sw-agent').all()) {
        const id = await agent.getAttribute('data-agent');
        await agent.click();
        await expect(agent).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#swarm-inspector .sw-inspector-id')).toHaveText(id);
      }
      await page.locator('.sw-inspector-details summary').click();
      await reachable('#swarm-inspector .sw-history', '#swarm-stage');
      await page.locator('.sw-inspector-details summary').click();
      await reachable('.sw-future', '#swarm-stage');
      assert.equal(calls.length, beforeSwarm, 'authored Swarm makes no API/model calls');

      await page.locator('#nav-backtest').click();
      await marketScope(); await bounded('Backtest');
      await expect(page.locator('.workspace-why')).toBeHidden();
      await reachable('#backtest-status', '#backtest-workspace');
      await page.locator('#backtest-symbol').selectOption('QQQ');
      await marketScope();
      await expect(page.locator('#workspace-location')).toHaveText('Backtest');
      await page.locator('#nav-research').click();
      await marketScope(); await bounded('Correlation');
      await page.locator('#research-tab-trigger').click();
      await marketScope(); await bounded('Event studies');
      await reachable('#trigger-status', '#research-workspace');
      await page.locator('#nav-markets').click();
      await marketScope(); await bounded('Markets restored');
      await expect(page.locator('.workspace-why')).toBeVisible();
      await reachable('#selected-evidence > summary', '#markets-view');
      await expect(page.locator('#copilot-panel')).toBeVisible();
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'zero external browser requests');
  assert.ok(calls.every(method => ['market.show', 'guru.funds', 'guru.quarters', 'guru.fund'].includes(method)));
});