// Presentation/transport fixtures only. No real inference, Yahoo requests or market writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

test('one Backtest workspace, canonical rules, explicit review/run and isolated module lifecycles', async () => {
  const html = await readFile(new URL('../../ui/gui/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'no duplicate IDs or backtest forms');
  const research = await readFile(new URL('../../ui/gui/research.js', import.meta.url), 'utf8');
  assert.doesNotMatch(research, /originalSlot|research-backtest-slot|guru-form|swarmFrame/);
  assert.doesNotMatch(html, /research-tab-(allocation|dynamic|vibe|swarm|markets)|id="guru-form"/);
  const calls = [], errors = [];
  const snapshot = {
    manifest: { id: '77777777-7777-4777-8777-777777777777', kind: 'real_market_snapshot', provider: 'Yahoo Finance', raw_sha256: {}, request_urls: {} }, summary: [],
    symbols: ['SPY', 'QQQ'].map(symbol => ({ symbol, currency: 'USD', bars: [
      { date: '2026-01-02', timestamp: 1767358800, open: '100', high: '102', low: '99', close: '101', volume: '1000' },
      { date: '2026-01-05', timestamp: 1767618000, open: '101', high: '103', low: '100', close: '102', volume: '1100' },
    ] })),
  };
  const proposal = { entry: { all: [{ left: { indicator: 'sma', period: 17 }, op: 'gt', right: 'sma50' }, { not: { left: 'rsi14', op: 'gte', right: '70' } }] }, exit: { left: 'close', op: 'lt', right: 'sma20' } };
  const app = await startGUI({ backend: {
    on() {}, async close() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === 'market.show') return structuredClone(snapshot);
      throw Object.assign(new Error('Test rejects execution; no invented finance result'), { code: 'input_rejected' });
    },
  }, copilot: {
    async close() {}, async status() { calls.push({ method: 'test.status' }); return { status: 'ready', authenticated: true, models: [{ id: 'test-model', name: 'TEST fixture, not real AI' }] }; },
    async criteria(request) { calls.push({ method: 'test.criteria', request }); return { contextIdentity: request, scope: 'saved_snapshot_only', model: request.model, criteria: proposal, explanation: 'TEST transport fixture, not real AI output.' }; },
  } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    // Test only the integration contract; sibling agents own these module implementations.
    await page.route('**/swarm.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.swarmCalls=[];window.ITTSwarm=root=>{window.swarmCalls.push(root.id);return {setVisible:value=>window.swarmCalls.push(value)}};' }));
    await page.route('**/guru.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.guruCalls=[];window.ITTGuru=({root,api,node})=>{window.guruCalls.push(root.id);return {show:()=>window.guruCalls.push("show"),hide:()=>window.guruCalls.push("hide")}};' }));
    await page.goto(app.url);
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    await expect(page.locator('#criteria-connect')).toHaveCount(0);
    await expect(page.locator('#copilot-open-settings')).toHaveCount(0);
    await expect(page.locator('#copilot-check')).toHaveCount(1);
    await expect(page.locator('#settings-dialog #copilot-check')).toHaveCount(1);
    await expect(page.locator('#nav-settings')).toBeVisible();
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('#markets-view #backtest-form, #markets-view #criteria-question').count(), 0);
    assert.equal(await page.locator('#backtest-workspace #backtest-form').count(), 1);
    assert.equal(await page.locator('#backtest-workspace #backtest-results').count(), 1);
    assert.equal(await page.locator('#backtest-workspace #backtest-progress-panel').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.guruCalls), []);
    await page.locator('#nav-backtest').click();
    await expect(page.locator('#markets-view')).toBeHidden();
    await expect(page.locator('#nav-backtest')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#criteria-natural')).toBeVisible();
    await expect(page.locator('#criteria-manual')).toBeHidden();
    await expect(page.locator('#backtest-preview')).toBeDisabled();
    await page.locator('#criteria-question').fill('TEST description before connection');
    await expect(page.locator('#criteria-generate')).toBeDisabled();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('#close-settings')).toBeFocused();
    await expect(page.locator('#copilot-model')).toBeDisabled();
    assert.ok(calls.every(call => call.method === 'market.show'));
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-settings')).toBeFocused();
    await page.locator('#criteria-source-manual').click();
    await page.locator('#criteria-manual > summary').click();
    await page.locator('#criteria-entry-right').fill('sma20');
    await page.locator('#backtest-preview').click();
    await expect(page.locator('#backtest-run')).toBeEnabled();
    await expect(page.locator('#backtest-review-summary')).toContainText('buy and hold');
    await page.locator('#backtest-fee').fill('11');
    await expect(page.locator('#backtest-run')).toBeDisabled();
    await page.locator('#backtest-tab-single').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#backtest-tab-portfolio')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#portfolio-fields')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.locator('#dynamic-fields')).toBeVisible();
    await page.locator('#backtest-preview').click();
    await expect(page.locator('#backtest-run')).toBeEnabled();
    const dynamic = JSON.parse(await page.locator('#backtest-spec').textContent());
    assert.equal(dynamic.allocation.mode, 'momentum');
    await page.locator('#backtest-tab-single').click();
    await page.locator('#criteria-source-natural').click();
    await expect(page.locator('#backtest-preview')).toBeDisabled();
    await page.locator('#criteria-question').fill('TEST description: bounded compound entry and exit');
    await expect(page.locator('#criteria-generate')).toBeDisabled();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#close-settings')).toBeFocused();
    assert.ok(calls.every(call => call.method === 'market.show'), 'Navigation must not check connection or generate rules');
    await page.locator('#copilot-check').click();
    await expect(page.locator('#copilot-model')).toBeEnabled();
    await page.locator('#copilot-model').selectOption('test-model');
    await page.locator('#close-settings').click();
    await expect(page.locator('#nav-settings')).toBeVisible();
    await expect(page.locator('#criteria-generate')).toBeEnabled();
    const beforeNavigation = calls.length;
    await page.locator('#nav-markets').click();
    await page.locator('#nav-backtest').click();
    await page.locator('#nav-settings').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-settings')).toBeFocused();
    assert.equal(calls.length, beforeNavigation, 'Ready-state navigation must not request status or generation');
    assert.equal(calls.filter(call => call.method === 'test.criteria').length, 0);
    await page.locator('#criteria-generate').click();
    await expect(page.locator('#criteria-summary')).toBeVisible();
    await expect(page.locator('#criteria-summary-rules')).toContainText('SMA(17 sessions)');
    await expect(page.locator('#criteria-summary-rules')).toContainText('NOT');
    await expect(page.locator('#backtest-run')).toBeDisabled();
    await page.locator('#backtest-preview').click();
    await expect(page.locator('#backtest-run')).toBeEnabled();
    await page.locator('#criteria-question').fill('Changed TEST description');
    await expect(page.locator('#backtest-review')).toBeHidden();
    await expect(page.locator('#backtest-preview')).toBeDisabled();
    await expect(page.locator('#backtest-run')).toBeDisabled();
    await page.locator('#criteria-source-manual').click();
    await expect(page.locator('#criteria-entry-left')).toBeDisabled();
    await page.locator('#criteria-expert > summary').click();
    await expect(page.locator('#criteria-advanced-json')).toBeEnabled();
    await page.locator('#backtest-preview').click();
    const reviewed = JSON.parse(await page.locator('#backtest-spec').textContent());
    assert.equal(reviewed.entry.all[0].left.period, 17, 'explicit manual switch retains full compound JSON');
    await page.locator('#backtest-run').click();
    await expect(page.locator('#backtest-error')).toBeVisible();
    assert.deepEqual(calls.find(call => call.method === 'market.backtest.stream')?.params.spec, reviewed);
    await page.locator('#nav-research').click();
    await expect(page.locator('#research-correlation')).toBeVisible();
    await page.locator('#research-tab-correlation').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#research-trigger')).toBeVisible();
    await page.locator('#nav-swarm').click();
    await expect(page.locator('#swarm-view')).toBeVisible();
    await expect(page.locator('#copilot-panel')).toBeHidden();
    assert.equal(await page.locator('#nav-research').getAttribute('aria-current'), null);
    assert.equal(await page.locator('[data-research-view][aria-selected="true"]').count(), 0);
    await page.locator('#nav-research').click();
    await expect(page.locator('#copilot-panel')).toBeHidden();
    await page.locator('#research-tab-guru').click();
    await page.locator('#nav-backtest').click();
    assert.deepEqual(await page.evaluate(() => window.guruCalls), ['guru-browser', 'show', 'hide']);
    const swarm = await page.evaluate(() => window.swarmCalls);
    assert.equal(swarm.filter(value => value === 'swarm-stage').length, 1);
    assert.ok(swarm.includes(true)); assert.equal(swarm.at(-1), false);
    await page.locator('#nav-markets').click();
    await page.locator('#copilot-question').fill('TEST ONLY ready-connection unsent draft');
    // Explicit DOM history fixture; no analyze call and no real model output.
    const chatFixture = await page.evaluateHandle(() => {
      const panel = document.querySelector('#copilot-panel'), question = document.querySelector('#copilot-question');
      const history = document.querySelector('#copilot-history'), entry = document.createElement('article');
      entry.textContent = 'TEST ONLY stored conversation sentinel'; history.append(entry);
      return { panel, question, history, entry, html: history.innerHTML, draft: question.value };
    });
    const beforeAllWorkspaces = calls.length;
    for (const view of ['markets', 'backtest', 'correlation', 'trigger', 'guru', 'swarm', 'markets']) {
      if (['correlation', 'trigger', 'guru'].includes(view)) {
        await page.locator('#nav-research').click(); await page.locator(`#research-tab-${view}`).click();
      } else await page.locator(`#nav-${view}`).click();
      if (view === 'markets') await expect(page.locator('#copilot-panel')).toBeVisible();
      else await expect(page.locator('#copilot-panel')).toBeHidden();
      assert.equal(await page.evaluate(f => f.panel === document.querySelector('#copilot-panel')
        && f.question === document.querySelector('#copilot-question') && f.history === document.querySelector('#copilot-history')
        && f.entry === f.history.lastElementChild && f.history.innerHTML === f.html && f.question.value === f.draft, chatFixture), true, `${view}: retain draft, history and node identities`);
      await page.locator('#nav-settings').click();
      await expect(page.locator('#settings-dialog')).toBeVisible();
      await expect(page.locator('#settings-dialog #copilot-check')).toBeVisible();
      await expect(page.locator('#copilot-check')).toHaveCount(1);
      await expect(page.locator('#copilot-model')).toHaveValue('test-model');
      await page.keyboard.press('Escape');
      await expect(page.locator('#nav-settings')).toBeFocused();
    }
    await chatFixture.dispose();
    assert.equal(calls.length, beforeAllWorkspaces, 'All-workspace navigation and Settings retain ready connection without requests');
    for (const width of [1500, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.reload();
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
      await page.locator('#nav-backtest').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no document overflow at ${width}`);
      assert.equal(await page.locator('#backtest-workspace').evaluate(el => getComputedStyle(el).display === 'none'), false);
      await expect(page.locator('#copilot-panel')).toBeHidden();
      const bounds = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { main: rect('#main'), shell: rect('.app-shell'), rail: rect('.rail'), chat: rect('#copilot-panel') };
      });
      assert.equal(bounds.chat.height, 0);
      for (const [edge, expected] of Object.entries({ left: bounds.rail.right, right: bounds.shell.right, top: bounds.shell.top, bottom: bounds.shell.bottom })) {
        assert.ok(Math.abs(bounds.main[edge] - expected) <= 1, `Backtest at ${width}: fully reclaimed ${edge} bound`);
      }
      await page.locator('#rail-markets').click();
      await expect(page.locator('#markets-view')).toBeVisible();
      await expect(page.locator('#backtest-workspace')).toBeHidden();
      await expect(page.locator('#copilot-panel')).toBeVisible();
    }
    assert.equal(calls.filter(call => call.method === 'test.criteria').length, 1);
    assert.ok(!calls.some(call => call.method === 'market.fetch'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await app.close(); }
});