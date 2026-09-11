// TEST ONLY: contract-shaped, authored display fixtures, not calculated financial evidence.
// Actual startGUI assets and Chromium; no Yahoo, model, Guru or backtest execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

const keys = ['rsi14', 'stoch9_6', 'stochrsi14', 'macd12_26', 'adx14', 'williams_r14',
  'cci14', 'atr14', 'highs_lows14', 'ultimate7_14_28', 'roc12', 'bull13', 'bear13'];
const statuses = ['Buy', 'Sell', 'Neutral', 'Unavailable'];
const display = text => text.replaceAll('Neutral', 'Hold').replaceAll('neutral', 'Hold');
const voteRules = {
  trend: 'sma20 > sma50: Buy; < : Sell; = : Neutral; null: Unavailable.',
  macd: 'macd12_26 > macd_signal9: Buy; < : Sell; = : Neutral; null: Unavailable.',
  rsi: 'RSI14 >55: Buy; <45: Sell; 45..55 inclusive: Neutral; null: Unavailable.',
};
const variants = [
  { status: 'Buy', votes: ['Buy', 'Buy', 'Neutral'], counts: { Buy: 2, Sell: 0, Neutral: 1, Unavailable: 0 } },
  { status: 'Sell', votes: ['Sell', 'Sell', 'Neutral'], counts: { Buy: 0, Sell: 2, Neutral: 1, Unavailable: 0 } },
  { status: 'Neutral', votes: ['Buy', 'Sell', 'Neutral'], counts: { Buy: 1, Sell: 1, Neutral: 1, Unavailable: 0 } },
  { status: 'Unavailable', votes: ['Buy', 'Neutral', 'Unavailable'], counts: { Buy: 1, Sell: 0, Neutral: 1, Unavailable: 1 } },
  { status: 'Buy', votes: ['Neutral', 'Buy', 'Buy'], counts: { Buy: 2, Sell: 0, Neutral: 1, Unavailable: 0 } },
  { status: 'Unavailable', votes: ['Unavailable', 'Sell', 'Sell'], counts: { Buy: 0, Sell: 2, Neutral: 0, Unavailable: 1 } },
  { status: 'Unavailable', votes: ['Sell', 'Unavailable', 'Buy'], counts: { Buy: 1, Sell: 1, Neutral: 0, Unavailable: 1 } },
  { status: 'Unavailable', votes: ['Buy', 'Neutral', 'Unavailable'], counts: { Buy: 1, Sell: 0, Neutral: 1, Unavailable: 1 } },
];
function fixture() {
  const bars = Array.from({ length: 64 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    timestamp: Date.UTC(2026, 0, 1 + index, 21) / 1000,
    open: '101.25000', high: '104.00000', low: '99.75000', close: '102.12500', volume: '1000000',
  }));
  const allKeys = [...keys, 'macd_signal9', 'plus_di14', 'minus_di14',
    ...[5, 10, 20, 50, 100, 200].flatMap(p => [`sma${p}`, `ema${p}`])];
  const series = Object.fromEntries(allKeys.map((key, k) => [key,
    bars.map((_, i) => i === 0 ? null : `${k + 1}.${String(i).padStart(2, '0')}123456789000`)]));
  const observations = bars.map((_, index) => {
    const variant = variants[index % variants.length];
    return { status: variant.status, counts: variant.counts,
      reasons: ['trend', 'macd', 'rsi'].map((id, i) => ({ id, label: `TEST ${id} label`,
        status: variant.votes[i], rule: voteRules[id],
        explanation: `TEST ONLY ${id} reason at ${index}: ${variant.votes[i] === 'Unavailable'
          ? 'Required value is null; this vote is unavailable, not neutral.' : `${variant.votes[i]}.`} <b>literal backend text</b>`,
        values: { exact: variant.votes[i] === 'Unavailable' ? null : '12.34000000000000000001' },
      })) };
  });
  return {
    manifest: { id: '88888888-8888-4888-8888-888888888888', kind: 'real_market_snapshot',
      provider: 'Yahoo Finance', collected_at: 'TEST ONLY · offline authored display fixture', raw_sha256: {}, request_urls: {} },
    summary: [], limitations: ['TEST ONLY: authored display fixture, not financial calculation or saved Yahoo validation.'],
    symbols: ['SPY', 'QQQ'].map(symbol => ({ symbol, currency: 'USD', exchange: 'TEST ONLY · offline display fixture', bars,
      technicals: { version: '1', basis: 'provider_close', series, rsi14: series.rsi14,
        sma20: series.sma20, sma50: series.sma50,
        definitions: Object.fromEntries(allKeys.map(key => [key, `TEST ONLY ${key} definition`])) },
      signals: { version: 'technical-vote-v1', basis: 'provider_close',
        rule: 'TEST ONLY · authored vote contract. Any unavailable vote makes the overall status Unavailable; otherwise at least two Buy votes mean Buy, at least two Sell votes mean Sell, and all other combinations mean Neutral.', observations },
    })),
  };
}

test('indicator visuals: actual Chromium, exact fixture values, validated votes and compact workspaces', async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const runs = path.join(process.env.ITT_TEST_OUTPUT_DIR || path.join(root, 'output'), 'indicator-visual-verification');
  await fs.mkdir(runs, { recursive: true });
  const output = await fs.mkdtemp(path.join(runs, `${new Date().toISOString().replaceAll(':', '-')}-`));
  const report = { fixture: 'TEST ONLY · authored contract-shaped display data; not financial validation',
    status: 'RUNNING', checks: [], screenshots: [], calls: [], externalRequests: [], errors: [], layouts: [] };
  let snapshot = fixture(), browser, app;
  const deny = method => { report.calls.push(method); throw new Error(`Forbidden verification call: ${method}`); };
  try {
    app = await startGUI({ backend: { on() {}, async close() {}, async request(method) {
      report.calls.push(method);
      assert.equal(method, 'market.show');
      return structuredClone(snapshot);
    } }, copilot: { async close() {}, status: () => deny('copilot.status'),
      analyze: () => deny('copilot.analyze'), criteria: () => deny('copilot.criteria') },
    guru: { request: () => deny('guru.request') } });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === app.origin) return route.continue();
      report.externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    const apiCalls = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api')) apiCalls.push(request.postDataJSON().method);
    });
    await page.goto(app.url);
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    await page.reload();
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cp-accent').trim()), '#2465a8');
    const choose = async index => {
      await page.locator(`#observations-body tr[data-timestamp="${snapshot.symbols[0].bars[index].timestamp}"] button`).click();
      await expect(page.locator('#technical-summary')).toHaveAttribute('data-timestamp', String(snapshot.symbols[0].bars[index].timestamp));
    };
    const capture = async name => {
      await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name);
    };
    const readRows = () => page.locator('#technical-summary-body tr').evaluateAll(rows => rows.map(row => ({
      key: row.dataset.indicator, raw: row.dataset.value, category: row.dataset.category,
      cells: row.children.length, td: row.querySelectorAll(':scope > td').length,
      value: row.children[1].textContent, title: row.children[1].title, cellRaw: row.children[1].dataset.value,
    })));
    await t.test('all four statuses, exact reasons/counts, date pinning and reading categories', async () => {
      const seen = { trend: new Set(), macd: new Set(), rsi: new Set() };
      const markerPaths = { Buy: 'M12 20V4M5 11l7-7 7 7', Sell: 'M12 4v16M5 13l7 7 7-7',
        Neutral: 'M4 12h16', Unavailable: 'M4 12h5M15 12h5' };
      for (let index = 56; index < 64; index++) {
        await choose(index);
        const expected = snapshot.symbols[0].signals.observations[index];
        await expect(page.locator('#signal-button')).toHaveAttribute('data-status', expected.status);
        await expect(page.locator('#signal-button')).toHaveAccessibleName(`${display(expected.status)} technical signal · show or hide reasons`);
        await expect(page.locator('#signal-status')).toHaveText(display(expected.status));
        await expect(page.locator('#signal-availability')).toContainText(`${display(expected.status)} · backend assessment`);
        await expect(page.locator('#signal-vote-summary')).toHaveAttribute('data-date', snapshot.symbols[0].bars[index].date);
        await expect(page.locator('#signal-vote-summary')).toHaveAttribute('data-archive', snapshot.manifest.id);
        const tiles = await page.locator('.signal-vote-tile').evaluateAll(nodes => nodes.map(el => ({
          id: el.dataset.rule, status: el.dataset.status, icon: el.querySelector('svg').dataset.icon,
          label: el.querySelector('.signal-vote-label').textContent, title: el.title,
          text: el.querySelector('.signal-vote-status').textContent,
          path: el.querySelector('svg path').getAttribute('d'),
          color: getComputedStyle(el.querySelector('.signal-vote-status')).color,
          iconColor: getComputedStyle(el.querySelector('svg')).stroke,
          expectedColor: (() => {
            const probe = document.createElement('span');
            probe.style.color = `var(--cp-${{ Buy: 'success', Sell: 'danger', Neutral: 'warning', Unavailable: 'text-muted' }[el.dataset.status]})`;
            el.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color;
          })(),
        })));
        assert.deepEqual(tiles.map(tile => tile.label), ['Trend', 'MACD', 'RSI']);
        expected.reasons.forEach((reason, i) => {
          assert.equal(tiles[i].id, reason.id); assert.equal(tiles[i].status, reason.status);
          assert.equal(tiles[i].icon, reason.status); assert.equal(tiles[i].title, display(`${reason.label}: ${reason.explanation}`));
          assert.equal(tiles[i].text, display(reason.status));
          assert.equal(tiles[i].path, markerPaths[reason.status]);
          assert.equal(tiles[i].color, tiles[i].expectedColor);
          assert.equal(tiles[i].iconColor, tiles[i].expectedColor);
          seen[reason.id].add(reason.status);
        });
        for (const selector of ['#signal-vote-counts', '#signal-counts']) {
          const counts = await page.locator(`${selector} > div`).evaluateAll(nodes => Object.fromEntries(nodes.map(el => [el.firstChild.textContent, Number(el.lastChild.textContent)])));
          assert.deepEqual(counts, Object.fromEntries(statuses.map(status => [display(status), expected.counts[status]])));
        }
        await expect(page.locator('#technical-summary-body [data-status], #technical-summary-body .signal-vote-status')).toHaveCount(0);
        const rows = await readRows();
        assert.deepEqual(rows.map(row => row.key), keys);
        assert.deepEqual(new Set(rows.map(row => row.category)), new Set(['trend', 'momentum', 'volatility', 'position']));
        for (const row of rows) {
          const value = snapshot.symbols[0].technicals.series[row.key][index];
          assert.equal(row.cells, 3); assert.equal(row.td, 2); // Existing th + td + td, not a fourth ratings column.
          assert.equal(row.raw, value); assert.equal(row.cellRaw, value); assert.equal(row.title, value);
          assert.equal(row.value, Number(value).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 }));
        }
        await page.locator('#signal-button').focus(); await page.keyboard.press('Enter');
        await expect(page.locator('#signal-details')).toBeVisible();
        await expect(page.locator('#signal-rule')).toHaveText(display(snapshot.symbols[0].signals.rule));
        await expect(page.locator('#signal-disclaimer')).toContainText('Hold means no directional vote, not a trading instruction; Unavailable means a vote is missing');
        for (const reason of expected.reasons) {
          const evidence = page.locator(`#signal-reasons [data-id="${reason.id}"]`);
          await expect(evidence).toHaveAttribute('data-status', reason.status);
          await expect(evidence.locator('h4')).toHaveText(display(`${reason.label}${reason.status}`));
          await expect(evidence.locator(':scope > p')).toHaveText(display(reason.explanation));
          await evidence.locator('summary').click();
          await expect(evidence.locator('details > p')).toBeVisible();
          await expect(evidence.locator('details > p')).toHaveText(display(reason.rule));
          await expect(evidence.locator('dd')).toHaveAttribute('data-value', reason.values.exact ?? 'null');
          await expect(evidence.locator('b')).toHaveCount(0);
        }
        const signalSurfaces = page.locator('#signal-button, #signal-details, #signal-vote-summary');
        assert.doesNotMatch((await signalSurfaces.allTextContents()).join(' '), /\bneutral\b/i);
        for (const surface of await signalSurfaces.all()) {
          assert.doesNotMatch(await surface.ariaSnapshot(), /\bneutral\b/i);
        }
        const accessibleText = await signalSurfaces.locator('[title], [aria-label]').evaluateAll(nodes =>
          nodes.map(el => `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`).join(' '));
        assert.doesNotMatch(accessibleText, /\bneutral\b/i);
        await page.locator('#signal-button').click();
        await page.locator('#signal-vote-summary').scrollIntoViewIfNeeded();
        await capture(`votes-${display(expected.status).toLowerCase()}-${index}.png`);
      }
      for (const [id, votes] of Object.entries(seen)) assert.deepEqual(votes, new Set(statuses), `${id}: every contract status has a tested marker`);
      const before = await readRows();
      await page.locator('[data-period="1M"]').click();
      assert.deepEqual(await readRows(), before);
      await page.locator('[data-period="3M"]').click();
      assert.deepEqual(await readRows(), before);
      await page.locator('[data-testid="watch-QQQ"]').click();
      await expect(page.locator('#signal-vote-summary')).toHaveAttribute('data-symbol', 'QQQ');
      await page.locator('[data-testid="watch-SPY"]').click();
      await expect(page.locator('#signal-vote-summary')).toHaveAttribute('data-symbol', 'SPY');
      await expect(page.locator('#signal-vote-legend')).toContainText('Hold means no directional vote, not a trading instruction; Unavailable means a vote is missing');
      await expect(page.locator('#signal-vote-legend')).toContainText('13 readings below are not additional Buy / Sell votes');
      await expect(page.locator('#signal-vote-legend')).toContainText('not execution orders');
      const glyphs = await page.locator('.ui-glyph').evaluateAll(nodes => nodes.map(el => ({
        hidden: el.getAttribute('aria-hidden'), focusable: el.getAttribute('focusable'), stroke: getComputedStyle(el).strokeWidth,
      })));
      assert.equal(glyphs.length, 24); // 8 existing controls, 13 categories, 3 votes.
      assert.ok(glyphs.every(g => g.hidden === 'true' && g.focusable === 'false' && g.stroke === '2px'));
      const shapes = await page.locator('.signal-vote-status svg path').evaluateAll(nodes => nodes.map(el => el.getAttribute('d')));
      assert.equal(new Set(shapes).size, 3, 'Buy, Hold and Unavailable have distinct shapes');
      report.checks.push('Each of three votes in all four contract states: computed traffic colors and distinct directional markers; internal Neutral displayed/accessibly named Hold throughout counts, rules and reasons; exact selected values, categories and keyboard/date/period/symbol pinning');
    });
    await t.test('null, absent/malformed contracts fail closed without derived votes', async () => {
      await page.locator('[data-period="1Y"]').click(); await choose(0);
      const value = page.locator('#technical-summary-body tr').first().locator('td').first();
      await expect(value).toHaveAttribute('data-value', 'null');
      await expect(value).toHaveAttribute('title', 'null');
      await expect(value).toHaveAttribute('aria-label', 'Insufficient history / undefined');
      await expect(value.locator('[aria-hidden="true"]')).toHaveText('—');
      assert.match(await value.innerText(), /Insufficient history/); // Existing verify-gui compatibility.
      await page.locator('#technical-summary').scrollIntoViewIfNeeded(); await capture('missing-readings.png');
      for (const variant of ['missing', 'malformed', 'unsupported']) {
        snapshot = fixture();
        if (variant === 'missing') delete snapshot.symbols[0].signals;
        if (variant === 'malformed') snapshot.symbols[0].signals.observations[0].reasons[0].status = 'Strong Buy';
        if (variant === 'unsupported') snapshot.symbols[0].signals.version = 'unknown';
        await page.locator('#verify-market').click();
        await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
        await expect(page.locator('.signal-vote-tile[data-status="Unavailable"]')).toHaveCount(3);
        await expect(page.locator('#signal-vote-counts > div')).toHaveCount(0);
        await expect(page.locator('#signal-counts > div')).toHaveCount(0);
        await expect(page.locator('#signal-rule')).toBeEmpty();
        await expect(page.locator('#signal-status')).toHaveText('Unavailable');
        await expect(page.locator('#signal-reasons > section')).toHaveCount(0);
        await expect(page.locator('#signal-vote-availability')).toContainText('No votes substituted');
      }
      snapshot = fixture(); delete snapshot.symbols[0].technicals;
      await page.locator('#verify-market').click();
      await expect(page.locator('#technical-summary-body tr').first()).toHaveAttribute('data-value', 'unavailable');
      await expect(page.locator('#technical-summary-body tr').first().locator('td').first()).toHaveAttribute('aria-label', 'Unavailable');
      snapshot = fixture(); await page.locator('#verify-market').click();
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success'); await choose(62);
      report.checks.push('Exact null/absent datasets, accessible em dash, legacy null text; rejected signal contracts never substitute votes/counts');
    });
    await t.test('1440/800 layout, existing actions and Settings-only; Swarm fits 1366×768', async () => {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 800, height: 1000 }]) {
        await page.setViewportSize(viewport);
        await page.locator('#signal-vote-summary').scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => {
          const selectors = ['.topbar', '.top-navigation', '#signal-vote-summary', '#technical-summary', '.signal-vote-tile', '.technical-table-wrap', '#technical-summary table'];
          return { width: innerWidth, scroll: document.documentElement.scrollWidth,
            items: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(el => ({ selector,
              width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }))),
            icon: getComputedStyle(document.querySelector('#nav-markets .ui-glyph')).display };
        });
        assert.ok(layout.scroll <= viewport.width + 1, JSON.stringify(layout));
        for (const item of layout.items) {
          assert.ok(item.scroll <= item.width + 1, JSON.stringify(item));
          assert.ok(item.left >= 0 && item.right <= viewport.width + 1, JSON.stringify(item));
        }
        assert.equal(layout.icon === 'none', viewport.width === 800);
        report.layouts.push(layout);
        await capture(`technicals-${viewport.width}.png`);
        await page.locator('[data-indicator="bear13"][data-testid="technical-row"]').scrollIntoViewIfNeeded();
        await capture(`technical-readings-bottom-${viewport.width}.png`);
        await page.locator('#nav-backtest').click();
        await expect(page.getByRole('button', { name: 'Review rules & settings', exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Run backtest', exact: true })).toHaveCount(1);
        await expect(page.locator('#backtest-run')).toBeDisabled();
        await page.locator('#nav-research').click();
        await expect(page.locator('#research-correlation')).toBeVisible();
        await page.locator('#nav-settings').click();
        await expect(page.locator('#settings-dialog #copilot-check')).toHaveCount(1);
        await page.keyboard.press('Escape'); await expect(page.locator('#nav-settings')).toBeFocused();
        await expect(page.locator('#criteria-connect, #copilot-open-settings')).toHaveCount(0);
        await page.locator('#nav-markets').click();
      }
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.locator('#nav-swarm').click();
      await expect(page.locator('.sw-agent')).toHaveCount(8);
      await expect(page.locator('#copilot-panel')).toBeHidden();
      const swarm = await page.evaluate(() => ['html', '#swarm-stage', '#swarm-arena', '#swarm-inspector', '.sw-lineage-tree'].map(selector => {
        const el = document.querySelector(selector), r = el.getBoundingClientRect();
        return { selector, width: el.clientWidth, height: el.clientHeight, scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight, right: r.right, bottom: r.bottom, top: r.top };
      }));
      for (const item of swarm) {
        assert.ok(item.scrollWidth <= item.width + 1 && item.scrollHeight <= item.height + 1, JSON.stringify(item));
        assert.ok(item.right <= 1367 && item.bottom <= 769 && item.top >= -1, JSON.stringify(item));
      }
      report.layouts.push({ swarm }); await capture('swarm-1366x768.png');
      assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
      assert.ok(report.calls.every(method => method === 'market.show'));
      assert.ok(apiCalls.every(method => method === 'market.show'));
      report.apiCalls = apiCalls;
      report.checks.push('1440/800 no horizontal overflow; compact decorative navigation/actions, sole Settings entry, Swarm 1366×768 fit; market.show only');
    });
    report.status = report.checks.length === 3 ? 'PASS' : 'FAIL';
  } catch (error) { report.status = 'FAIL'; report.error = error.stack; throw error; }
  finally {
    await browser?.close(); await app?.close();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Indicator visual evidence: ${path.relative(root, output)}`);
  }
});