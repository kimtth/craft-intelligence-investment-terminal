// TEST ONLY presentation/transport fixtures. No Python, live prices, model or network feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

const dates = Array.from({ length: 240 }, (_, index) => new Date(Date.UTC(2025, 0, 2 + index)).toISOString().slice(0, 10));
const snapshot = {
  manifest: { id: '77777777-7777-4777-8777-777777777777', kind: 'real_market_snapshot', provider: 'Yahoo Finance', raw_sha256: {}, request_urls: {} }, summary: [],
  symbols: [{ symbol: 'SPY', currency: 'USD', bars: dates.map(date => ({ date,
    timestamp: Date.parse(`${date}T21:00:00Z`) / 1000, open: '100', high: '102', low: '99', close: '101', volume: '1000',
  })) }],
};
function fixture(spec, kind) {
  const book = (key, offset) => ({
    // These sentinel metrics deliberately cannot be obtained by summarizing the fixture curves.
    metrics: { initial_cash: kind === 'unknown-peak' ? null : '10000',
      cagr: kind === 'empty' || (kind === 'gaps' && key === 'strategy') ? null : key === 'strategy' ? '0.123456789012345678' : '-0.067890123456789012',
      max_drawdown: kind === 'empty' || (kind === 'gaps' && key === 'benchmark') ? null : key === 'strategy' ? '0.087654321098765432' : '0.054321098765432109',
      final_nav: '11000', final_cash: '11000', total_return: '0.1', fees: '0', fill_count: 0 },
    fills: [],
    daily: dates.map((date, index) => ({ date, nav: kind === 'empty' || (kind === 'gaps' && index === 3) ? null
      : kind === 'flat' ? '10000' : String(9800 + offset + index * 6 - (index % 37) * 9) + '.01234567' })),
  });
  return { archive_id: spec.archive_id, symbol: spec.symbol, spec, contract: { version: 'criteria-v1', currency: 'USD' },
    strategy: book('strategy', 0), benchmark: book('benchmark', 50), signals: [], limitations: ['TEST ONLY chart fixture; not financial evidence.'] };
}
const wirePoints = dates.slice(0, 6).flatMap((date, index) => ['strategy', 'benchmark'].map(phase => ({
  phase, completed: index + 1, total: dates.length, date, nav: '9999.123456789',
  cagr: index === 0 || index === 3 ? null : index === 1 ? (phase === 'strategy' ? '123456.789012345678' : '23456.789012345678')
    : phase === 'strategy' ? '0.123456789012345678' : '-0.067890123456789012',
  max_drawdown: index === 3 ? null : phase === 'strategy' ? '0.087654321098765432' : '0.054321098765432109',
})));
const chartState = page => page.locator('#backtest-equity').evaluate(svg => {
  const rect = svg.getBoundingClientRect();
  return { width: rect.width, height: rect.height, viewWidth: svg.viewBox.baseVal.width,
    fonts: [...svg.querySelectorAll('text')].map(text => {
      const matrix = text.getScreenCTM();
      return { label: text.textContent, pixels: parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.c, matrix.d) };
    }),
    labelsInside: [...svg.querySelectorAll('text')].every(text => {
      const box = text.getBoundingClientRect();
      return box.left >= rect.left - 1 && box.right <= rect.right + 1 && box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1;
    }),
    lastX: svg.querySelector('#backtest-nav circle:last-of-type')?.getAttribute('cx'),
  };
});

async function assertLivePoints(page) {
  const svg = page.locator('#backtest-live-performance');
  await expect(page.locator('#backtest-live-charts svg')).toHaveCount(1);
  await expect(page.locator('#backtest-live-charts figure')).toHaveCount(1);
  await expect(svg.locator('path.live-line')).toHaveCount(4);
  for (const [id, metric] of [['backtest-live-cagr', 'cagr'], ['backtest-live-mdd', 'max_drawdown']]) {
    const group = svg.locator(`#${id}`);
    assert.equal(await group.evaluate(el => el.tagName), 'g', 'prior IDs remain groups inside the shared SVG');
    const expected = ['strategy', 'benchmark'].flatMap(phase => wirePoints.filter(point => point.phase === phase && point[metric] !== null)
      .map(point => ({ phase, portfolio: phase, metric, date: point.date, value: point[metric] })));
    await expect(group).toHaveAttribute('data-points', String(expected.length));
    assert.deepEqual(await group.locator('circle').evaluateAll(nodes => nodes.map(dot => ({
      phase: dot.dataset.phase, portfolio: dot.dataset.portfolio, metric: dot.dataset.metric, date: dot.dataset.date, value: dot.dataset.value,
    }))), expected, 'all exact backend strings retained, including positive running MDD and no day-zero CAGR');
    for (const phase of ['strategy', 'benchmark']) {
      const path = group.locator(`path.${phase}`);
      const d = await path.getAttribute('d');
      assert.equal((d.match(/M/g) || []).length, 2, 'each metric/phase path restarts at the null gap');
      assert.equal((d.match(/L/g) || []).length, expected.filter(point => point.phase === phase).length - 2);
      assert.doesNotMatch(d, /NaN|Infinity|C|Q/, 'straight segments only, no smoothing or invented values');
      assert.equal(await path.evaluate(el => getComputedStyle(el).strokeDasharray), phase === 'strategy' ? 'none' : '5px, 3px');
    }
  }
  const axis = await svg.evaluate(el => {
    const low = Number(el.dataset.axisMin), high = Number(el.dataset.axisMax);
    const points = [...el.querySelectorAll('circle')];
    return { low, high, sameScale: points.every(dot => Math.abs(Number(dot.getAttribute('cy'))
      - (150 - (Number(dot.dataset.value) - low) / (high - low) * 125)) < 1e-8),
    sameDates: points.every(dot => points.filter(other => other.dataset.date === dot.dataset.date)
      .every(other => other.getAttribute('cx') === dot.getAttribute('cx'))),
    colors: ['#backtest-live-cagr', '#backtest-live-mdd'].map(id => [...el.querySelectorAll(`${id} path`)].map(path => getComputedStyle(path).stroke)) };
  });
  assert.equal(axis.high, Number(wirePoints[2].cagr), 'large early backend CAGR sets the shared maximum, not a normalized cap');
  assert.equal(axis.low, Number('-0.067890123456789012'));
  assert.ok(axis.sameScale && axis.sameDates, 'four series share the exact same percentage and date axes');
  assert.equal(axis.colors[0][0], axis.colors[0][1]); assert.equal(axis.colors[1][0], axis.colors[1][1]);
  assert.notEqual(axis.colors[0][0], axis.colors[1][0], 'metric color, not portfolio color');
}

async function assertPoints(page, result) {
  for (const key of ['strategy', 'benchmark']) {
    const book = result[key];
    const nav = book.daily.filter(row => row.nav !== null).map(({ date, nav }) => ({ date, value: nav }));
    const read = id => page.locator(`#${id} circle[data-portfolio="${key}"]`).evaluateAll(nodes =>
      nodes.map(dot => ({ date: dot.dataset.date, value: dot.dataset.value })));
    assert.deepEqual(await read('backtest-nav'), nav, 'exact original NAV strings, no resampling or interpolation');
    let peak = book.metrics.initial_cash === null ? null : Number(book.metrics.initial_cash);
    const dd = [];
    for (const row of book.daily) {
      if (row.nav === null || peak === null) { peak = null; continue; }
      peak = Math.max(peak, Number(row.nav));
      dd.push({ date: row.date, value: String(100 * (Number(row.nav) / peak - 1)) });
    }
    assert.deepEqual(await read('backtest-drawdown'), dd, 'unchanged initial-cash peak and permanent unknown-peak gap behavior');
    for (const metric of ['cagr', 'max_drawdown']) {
      const badge = page.locator(`#backtest-performance-summary [data-portfolio="${key}"][data-metric="${metric}"]`);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-value', book.metrics[metric] ?? 'null');
      if (book.metrics[metric] === null) await expect(badge).toContainText('Unavailable');
      else await expect(badge).toContainText(`${(Number(book.metrics[metric]) * 100).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`);
    }
  }
}

test('native-pixel combined performance chart: production stream, resizing, exact metrics, gaps and hover', { timeout: 120000 }, async () => {
  const outputRoot = process.env.ITT_TEST_OUTPUT_DIR
    ? `${process.env.ITT_TEST_OUTPUT_DIR}/performance-chart-verification/`
    : fileURLToPath(new URL('../../output/performance-chart-verification/', import.meta.url));
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(`${outputRoot}${new Date().toISOString().replaceAll(':', '-')}-`);
  const calls = [], errors = [], external = [], layouts = [], screenshots = [];
  let kind = 'dense', result, release;
  const app = await startGUI({ backend: {
    on() {}, async close() {}, async request(method, params, options) {
      calls.push(method);
      if (method === 'market.show') return structuredClone(snapshot);
      assert.equal(method, 'market.backtest.stream', 'no other backend/model/network actions allowed');
      result = fixture(params.spec, kind);
      for (const point of wirePoints) options.onProgress(structuredClone(point));
      await new Promise(resolve => { release = resolve; });
      return structuredClone(result);
    },
  }, copilot: { async close() {}, async status() { throw new Error('Model/status calls prohibited'); } } });
  let browser;
  const report = { fixture: 'TEST ONLY production startGUI + fixture backend stream', liveFetch: false, modelCalls: 0, layouts, screenshots };
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== app.origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(app.url);
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    await page.locator('#nav-backtest').click();
    await page.locator('#criteria-source-manual').click();
    await page.locator('#criteria-manual > summary').click();
    await page.locator('#criteria-entry-right').fill('sma20');
    const run = async () => {
      await page.locator('#backtest-preview').click();
      await page.locator('#backtest-run').click();
      await expect(page.locator('#backtest-progress-status')).toHaveText('Running');
      await expect(page.locator('#backtest-benchmark-completed')).toHaveText('6');
      await expect(page.locator('#backtest-benchmark-total')).toHaveText('240');
    };
    await run();
    await expect(page.locator('.live-legend span')).toHaveText(['CAGR · Strategy', 'CAGR · Benchmark', 'MDD · Strategy', 'MDD · Benchmark']);
    await expect(page.locator('#backtest-live-note')).toContainText('large early CAGR can flatten MDD');
    let priorLive;
    for (const width of [1366, 1920, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.locator('#backtest-live-performance').evaluate(svg => Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width))).toBeLessThan(1);
      const live = await page.locator('#backtest-live-performance').evaluate(svg => ({ height: svg.getBoundingClientRect().height, width: svg.viewBox.baseVal.width,
        lastX: svg.querySelector('circle:last-of-type').getAttribute('cx'),
        fonts: [...svg.querySelectorAll('text')].map(text => parseFloat(getComputedStyle(text).fontSize) * Math.hypot(text.getScreenCTM().c, text.getScreenCTM().d)),
        labelsInside: [...svg.querySelectorAll('text')].every(text => {
          const box = text.getBoundingClientRect(), rect = svg.getBoundingClientRect();
          return box.left >= rect.left && box.right <= rect.right && box.top >= rect.top && box.bottom <= rect.bottom;
        }),
        labelsSeparate: [...svg.querySelectorAll('text')].every((text, index, labels) => {
          const a = text.getBoundingClientRect();
          return labels.slice(index + 1).every(other => {
            const b = other.getBoundingClientRect();
            return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          });
        }),
      }));
      assert.equal(live.height, 180);
      assert.ok(live.fonts.every(pixels => pixels >= 10.9 && pixels <= 11.1), 'live text stays 11 screen pixels');
      assert.ok(live.labelsInside && live.labelsSeparate, 'high CAGR axis labels fit without clipping or overlap');
      if (priorLive) { assert.notEqual(live.width, priorLive.width); assert.notEqual(live.lastX, priorLive.lastX); }
      priorLive = live;
      await assertLivePoints(page);
      layouts.push({ phase: 'progress', viewportWidth: width, ...live });
      const filename = `live-performance-${width}.png`;
      await page.locator('#backtest-live-charts figure').screenshot({ path: `${output}/${filename}` }); screenshots.push(filename);
    }
    const partialMarkup = await page.locator('#backtest-live-performance').innerHTML();
    await page.locator('#backtest-live-toggle').click();
    await expect(page.locator('#backtest-live-charts')).toBeHidden();
    await expect(page.locator('#backtest-progress')).toBeVisible();
    await expect(page.locator('#backtest-live-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#backtest-live-toggle').click();
    await expect(page.locator('#backtest-live-charts')).toBeVisible();
    await expect(page.locator('#backtest-live-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.locator('#backtest-live-performance').innerHTML()).toBe(partialMarkup);
    release();
    await expect(page.locator('#backtest-results')).toBeVisible();
    await expect(page.locator('#backtest-progress-panel')).toHaveAttribute('data-state', 'complete');
    await expect.poll(() => page.locator('#backtest-live-performance').innerHTML()).toBe(partialMarkup);
    await assertLivePoints(page);
    let prior;
    for (const width of [1366, 1920, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(async () => { const state = await chartState(page); return Math.abs(state.width - state.viewWidth); }).toBeLessThan(1);
      await expect(page.locator('#backtest-results figure')).toHaveCount(1);
      await expect(page.locator('#backtest-results figure svg')).toHaveCount(1);
      await expect(page.locator('#backtest-performance-title')).toHaveText('Performance · CAGR & MDD');
      await expect(page.locator('#backtest-drawdown')).toHaveAttribute('data-axis-max', '0');
      await assertPoints(page, result);
      await page.locator('#backtest-performance').scrollIntoViewIfNeeded();
      const state = await chartState(page);
      assert.equal(state.height, 300); assert.ok(state.height <= 360);
      assert.ok(state.fonts.every(({ pixels }) => pixels >= 10.9 && pixels <= 12.1), 'effective font size uses getScreenCTM, not computed font alone');
      assert.ok(state.labelsInside, 'all axis and lane labels fit inside the SVG');
      const summaryFits = await page.locator('#backtest-performance-summary').evaluate(summary => {
        const card = summary.closest('figure').getBoundingClientRect();
        return [...summary.querySelectorAll('strong, .performance-metric')].every(label => {
          const rect = label.getBoundingClientRect();
          return rect.width > 0 && rect.left >= card.left && rect.right <= card.right && rect.top >= card.top && rect.bottom <= card.bottom;
        });
      });
      assert.ok(summaryFits, 'strategy/benchmark and all four metrics visibly fit in the same card');
      if (prior) { assert.notEqual(state.viewWidth, prior.viewWidth); assert.notEqual(state.lastX, prior.lastX, 'resize redraws point coordinates'); }
      prior = state; layouts.push({ phase: 'final', width, ...state });
      const filename = `performance-${width}.png`;
      await page.locator('#backtest-performance').screenshot({ path: `${output}/${filename}` }); screenshots.push(filename);
    }
    const dot = page.locator('#backtest-nav circle[data-portfolio="strategy"]').nth(5);
    assert.equal(await dot.evaluate(el => getComputedStyle(el).fillOpacity), '0', 'dense points are not hundreds of visible circles');
    await dot.hover();
    assert.equal(await dot.evaluate(el => getComputedStyle(el).fillOpacity), '1');
    await expect(dot.locator('title')).toHaveText(`strategy · ${result.strategy.daily[5].date} · ${result.strategy.daily[5].nav}`);
    // Rendering after workspace hide/show must use its current size, not the hidden zero width.
    await page.locator('#nav-markets').click();
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.locator('#nav-backtest').click();
    await expect.poll(async () => { const state = await chartState(page); return Math.abs(state.width - state.viewWidth); }).toBeLessThan(1);
    await assertPoints(page, result);
    for (kind of ['gaps', 'unknown-peak', 'empty', 'flat']) {
      await page.locator('#backtest-fee').fill(String(kind.length));
      await run(); release();
      await expect(page.locator('#backtest-results')).toBeVisible();
      await assertPoints(page, result);
      if (kind === 'gaps') {
        const navPath = await page.locator('#backtest-nav path.strategy').getAttribute('d');
        assert.equal((navPath.match(/M/g) || []).length, 2, 'NAV restarts after missing point without bridging');
        await expect(page.locator('#backtest-drawdown circle.strategy')).toHaveCount(3);
      }
      if (kind === 'flat') await expect(page.locator('#backtest-drawdown')).toHaveAttribute('data-axis-max', '0');
      if (kind === 'empty') {
        await expect(page.locator('#backtest-equity circle')).toHaveCount(0);
        await expect(page.locator('#backtest-nav')).toContainText('unavailable');
        await expect(page.locator('#backtest-drawdown')).toContainText('unavailable');
        const filename = 'performance-unavailable.png';
        await page.locator('#backtest-performance').screenshot({ path: `${output}/${filename}` }); screenshots.push(filename);
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(calls.filter(method => method === 'market.backtest.stream').length, 5);
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack; throw error; }
  finally {
    release?.(); await browser?.close(); await app.close();
    await writeFile(`${output}/report.json`, JSON.stringify({ ...report, calls, errors, external }, null, 2));
    console.log(`Performance chart verification: ${output}`);
  }
});

test('progress labels and slots survive alternating events, digit growth, resets and terminal states', { timeout: 120000 }, async () => {
  let pending;
  const errors = [], external = [];
  const app = await startGUI({ backend: {
    on() {}, async close() {}, async request(method, params, options) {
      if (method === 'market.show') return structuredClone(snapshot);
      assert.equal(method, 'market.backtest.stream');
      return new Promise((resolve, reject) => { pending = { emit: options.onProgress, resolve: () => resolve(fixture(params.spec, 'dense')), reject }; });
    },
  }, copilot: { async close() {}, async status() { throw new Error('No model calls'); } } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== app.origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(app.url);
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'success');
    await page.locator('#nav-backtest').click();
    await page.locator('#criteria-source-manual').click();
    await page.locator('#criteria-manual > summary').click();
    await page.locator('#criteria-entry-right').fill('sma20');
    const run = async () => {
      pending = null;
      await page.locator('#backtest-preview').click();
      await page.locator('#backtest-run').click();
      await expect(page.locator('#backtest-progress-status')).toHaveText('Running');
      await expect.poll(() => Boolean(pending)).toBe(true);
      for (const phase of ['strategy', 'benchmark']) for (const key of ['completed', 'total']) {
        await expect(page.locator(`#backtest-${phase}-${key}`)).toHaveText('—');
      }
      await expect(page.locator('#backtest-progress-detail')).toContainText('Waiting for backend');
      assert.equal(await page.locator('#backtest-progress').evaluate(el => el.value), 0);
      await expect(page.locator('#backtest-live-performance circle')).toHaveCount(0);
    };
    await run();
    await page.locator('.progress-counts').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.progress-phase strong, .progress-count > span')];
      window.progressTestNodes = nodes;
      const origin = document.querySelector('.progress-counts').getBoundingClientRect();
      window.progressTestBounds = nodes.map(el => { const r = el.getBoundingClientRect(); return { x: r.x - origin.x, y: r.y - origin.y, width: r.width }; });
      window.progressStatusChanges = [];
      new MutationObserver(() => window.progressStatusChanges.push(document.getElementById('backtest-progress-status').textContent))
        .observe(document.getElementById('backtest-progress-status'), { childList: true, subtree: true, characterData: true });
    });
    const latest = { strategy: ['—', '—'], benchmark: ['—', '—'] };
    const verify = async () => {
      const observed = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('.progress-phase strong, .progress-count > span')];
        const origin = document.querySelector('.progress-counts').getBoundingClientRect();
        return { identity: nodes.every((el, i) => el === window.progressTestNodes[i]),
          bounds: nodes.map(el => { const r = el.getBoundingClientRect(); return { x: r.x - origin.x, y: r.y - origin.y, width: r.width }; }),
          baseline: window.progressTestBounds, text: nodes.map(el => el.textContent),
          changes: window.progressStatusChanges,
          tabular: [...document.querySelectorAll('.progress-count')].every(el => getComputedStyle(el).fontVariantNumeric === 'tabular-nums'),
          noLiveCounters: document.querySelector('.progress-counts').getAttribute('aria-live') === 'off' };
      });
      assert.ok(observed.identity && observed.tabular && observed.noLiveCounters);
      assert.deepEqual(observed.bounds, observed.baseline, 'label/slot positions and widths never shift at 9→10 or 99→100');
      assert.deepEqual(observed.text, ['Strategy', ...latest.strategy, 'Benchmark', ...latest.benchmark]);
      return observed;
    };
    // Every event passes real HTTP/controller validation and is observed before the next.
    for (const completed of [...Array.from({ length: 80 }, (_, i) => i + 1), 99, 100]) {
      for (const phase of ['strategy', 'benchmark']) {
        const total = phase === 'strategy' ? 100 : 101;
        pending.emit({ phase, completed, total, date: dates[completed - 1], nav: '9999.123456789', cagr: null, max_drawdown: '0.0000123456789' });
        await expect(page.locator(`#backtest-${phase}-completed`)).toHaveText(String(completed));
        latest[phase] = [String(completed), String(total)];
        const state = await verify();
        assert.deepEqual(state.changes, [], 'per-session events must not mutate the polite status');
      }
    }
    const live = await page.locator('#backtest-live-performance').innerHTML();
    pending.resolve();
    await expect(page.locator('#backtest-progress-status')).toHaveText('Complete · final result validated');
    await expect(page.locator('#backtest-results')).toBeVisible();
    await verify();
    assert.equal(await page.locator('#backtest-live-performance').innerHTML(), live);
    assert.equal(await page.locator('#backtest-benchmark-completed').textContent(), '100', 'terminal success does not invent missing progress 101');
    assert.equal(await page.locator('#backtest-progress').evaluate(el => el.value), 1);

    await run(); latest.strategy = ['—', '—']; latest.benchmark = ['—', '—'];
    await verify();
    pending.emit({ phase: 'strategy', completed: 9, total: 10, date: dates[8], nav: null, cagr: null, max_drawdown: null });
    await expect(page.locator('#backtest-strategy-completed')).toHaveText('9');
    latest.strategy = ['9', '10']; await verify();
    const fraction = await page.locator('#backtest-progress').evaluate(el => el.value);
    pending.reject(new Error('TEST stream interrupted'));
    await expect(page.locator('#backtest-progress-panel')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#backtest-progress-status')).toContainText('Failed');
    await verify();
    assert.equal(await page.locator('#backtest-progress').evaluate(el => el.value), fraction);
    await run(); latest.strategy = ['—', '—']; latest.benchmark = ['—', '—'];
    pending.resolve(); // A valid final-only response must not invent either counter.
    await expect(page.locator('#backtest-progress-panel')).toHaveAttribute('data-state', 'complete');
    await verify();
    await expect(page.locator('#backtest-progress-status')).toHaveAttribute('aria-live', 'polite');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } finally { pending?.resolve(); await browser?.close(); await app.close(); }
});