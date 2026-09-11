// Fixtures below are explicitly test-only. These tests do not prove live Yahoo or physical TUI behavior.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { kit } from './helpers/dependencies.js';
import { sanitize } from '../../ui/index.js';
import { SYMBOLS, LOOKBACKS, KEYS, FOOTER_MARKER, formatPrice, filterBars, sampleBars, priceChart,
  marketLayout, hitTest, summaryLines, priceLines, provenanceLines, notesLines, startMarketUI } from '../../ui/market.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(count = 260) {
  const bars = Array.from({ length: count }, (_, i) => ({ timestamp: 1735689600 + i * 86400,
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: String(100 + i), high: String(102 + i), low: String(99 + i),
    close: String(101 + i), volume: String(1000000 + i) }));
  return {
    manifest: { id: '00000000-0000-4000-8000-000000000001', provider: 'Yahoo Finance',
      collected_at: '2026-09-10T12:00:00Z', kind: 'real_market_snapshot', schema_version: '0.1',
      symbols: [...SYMBOLS], current_archive_not_pit: true, external_audit: false,
      historical_universe_verified: false, latestbar_may_be_incomplete: true,
      price_basis: 'provider chart close (not total return; split adjustment possible)',
      raw_sha256: Object.fromEntries(SYMBOLS.map(symbol => [`raw-${symbol}.json`, 'a'.repeat(64)])),
      request_urls: Object.fromEntries(SYMBOLS.map(symbol => [symbol,
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d&events=div%2Csplits`])),
      rights: { use: 'local_research', public_redistribution: 'not_verified' } },
    symbols: SYMBOLS.map(symbol => ({ symbol, currency: 'USD', exchange: 'TEST',
      timezone: 'America/New_York', date_basis: 'exchange_timezone', bars: structuredClone(bars),
      missing_bars: { skipped_count: 1, skipped_timestamps: [123], filled_count: 0,
        reason: 'null_ohlcv', calendar_gaps: 'not_evaluated' }, events: {} })),
    // Deliberately inconsistent with fixture prices: UI must display backend metrics, not recalculate.
    summary: SYMBOLS.map(symbol => ({ symbol, first_date: bars[0]?.date, last_date: bars.at(-1)?.date,
      first_price: bars[0]?.close, last_price: bars.at(-1)?.close, pricechange_pct: '7.1251',
      metric: 'price_change_not_investment_return' })),
  };
}
function fakeTerm(width = 160, height = 42) {
  const term = new EventEmitter(), modes = [], frames = []; let cursor = { x: 1, y: 1 }, frame = [];
  Object.assign(term, { width, height, modes, frames,
    clear() { frame = []; frames.push(frame); },
    moveTo(x, y) {
      assert.ok(x >= 1 && x < term.width, `x=${x}, width=${term.width}`);
      assert.ok(y >= 1 && y < term.height, `y=${y}, height=${term.height}`);
      cursor = { x, y };
    },
    styleReset() {}, fullscreen(value) { modes.push(['fullscreen', value]); },
    grabInput(value) { modes.push(['grabInput', value]); }, hideCursor(value) { modes.push(['hideCursor', value]); },
    text() { return frame.map(row => row.text).join('\n'); },
    // Reconstruct final cells, not just write logs: detects text overwriting pane borders.
    screen(rect = { x: 1, y: 1, width: term.width, height: term.height }) {
      const cells = Array.from({ length: term.height }, () => Array(term.width).fill(' '));
      for (const write of frame) {
        let x = write.x - 1;
        for (const char of write.text) {
          const width = kit.stringWidth(char);
          cells[write.y - 1][x] = char;
          for (let i = 1; i < width; i++) cells[write.y - 1][x + i] = '';
          x += width;
        }
      }
      return cells.slice(rect.y - 1, rect.y - 1 + rect.height)
        .map(row => row.slice(rect.x - 1, rect.x - 1 + rect.width).join('')).join('\n');
    },
  });
  for (const background of ['bgBlack', 'bgBlue']) {
    term[background] = () => {};
    for (const color of ['white', 'cyan', 'yellow', 'blue', 'green']) term[background][color] = { noFormat(text) {
      assert.equal(sanitize(text), text, 'terminal control characters must be sanitized');
      assert.ok(cursor.x + kit.stringWidth(text) <= term.width, 'no horizontal autowrap');
      frame.push({ ...cursor, text, color, background });
    } };
  }
  return term;
}
function fakeBackend(overrides = {}) {
  const backend = new EventEmitter(); backend.calls = []; backend.closed = 0;
  backend.request = async (method, params) => {
    backend.calls.push({ method, params });
    assert.ok(['market.fetch', 'market.show'].includes(method), `forbidden RPC: ${method}`);
    return overrides[method] ? overrides[method](params) : fixture();
  };
  backend.close = () => { backend.closed++; return overrides.close?.(); };
  return backend;
}
function setup(overrides = {}, options = {}) {
  const term = fakeTerm(), backend = fakeBackend(overrides), input = new EventEmitter(), signals = new EventEmitter();
  const ui = startMarketUI({ term, backend, input, signals, root: path.resolve('market-test-root'), ...options });
  return { term, backend, input, signals, ui };
}
function click(term, ui, id, dy = 0) {
  const hit = ui.controls.find(control => control.id === id);
  assert.ok(hit, `control ${id}`);
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: hit.x + 1, y: hit.y + dy });
}

test('lookbacks slice only actual bars; endpoints, dates, gaps and input remain untouched', () => {
  const bars = fixture().symbols[0].bars;
  const original = structuredClone(bars);
  for (const [key, count] of [['1', 21], ['2', 63], ['3', 126], ['4', 260]]) {
    const selected = filterBars(bars, key);
    assert.equal(selected.length, count); assert.equal(selected[0], bars.at(-count));
    assert.equal(selected.at(-1), bars.at(-1));
  }
  assert.deepEqual(filterBars(bars.slice(0, 3), '1'), bars.slice(0, 3));
  assert.deepEqual(filterBars(bars, 'bogus'), []); assert.deepEqual(filterBars(null), []);
  const gaps = [bars[0], bars[10], bars[20]];
  assert.deepEqual(filterBars(gaps), gaps); assert.deepEqual(bars, original);
  assert.equal(LOOKBACKS[3].bars, null);
});

test('sampling includes endpoints without generating data or mutating its source', () => {
  const bars = fixture().symbols[0].bars;
  const samples = sampleBars(bars, 17);
  assert.equal(samples.length, 17); assert.equal(samples[0], bars[0]); assert.equal(samples.at(-1), bars.at(-1));
  assert.equal(new Set(samples).size, 17); assert.ok(samples.every(row => bars.includes(row)));
  assert.deepEqual(sampleBars(bars, 1), [bars.at(-1)]); assert.deepEqual(sampleBars(bars, 0), []);
  assert.deepEqual(sampleBars(bars, NaN), []);
});

test('Braille close chart plots every actual sample, preserves dates and handles single/flat/falling/gapped prices', () => {
  const bars = fixture().symbols[0].bars;
  for (const series of [[bars[0]], [bars[0], { ...bars[1], close: bars[0].close }],
    bars.map((row, i) => ({ ...row, close: String(900 - i) })), [bars[0], bars[100], bars[200]]]) {
    const chart = priceChart(series, 64, 7);
    assert.equal(chart.lines.length, 11); assert.match(chart.lines.join(''), /[\u2801-\u28ff]/);
    assert.deepEqual(chart.samples, series); assert.notEqual(chart.samples, series);
    assert.equal(chart.plotted, series.length); assert.equal(chart.points.length, series.length);
    assert.equal(chart.aggregated + chart.occupied, chart.plotted);
    assert.ok(chart.lines.every(line => kit.stringWidth(line) <= 64));
    assert.ok(chart.lines.join('\n').includes(series[0].date));
    assert.ok(chart.lines.join('\n').includes(series.at(-1).date));
    assert.ok(chart.lines.join('\n').includes(series[Math.floor((series.length - 1) / 2)].date));
    assert.ok(chart.lines.join('\n').includes('no interpolation'));
  }
  for (const value of [null, '', ' ', 'NaN', 'Infinity', '-1', '0', '0x10']) {
    assert.match(priceChart([{ ...bars[0], close: value }]).lines.join(''), /unavailable/);
  }
  assert.match(priceChart([]).lines[0], /No archived prices/);
  assert.ok(priceChart(bars, 1).lines.every(line => kit.stringWidth(line) <= 1));
});

test('Braille bitmasks contain only quantized sample dots, including unsampled extrema and merged collisions', () => {
  const bars = fixture().symbols[0].bars;
  bars[117].close = '1000';
  const original = structuredClone(bars), graph = priceChart(bars, 37, 5);
  const masks = graph.lines.slice(0, 5).map(row => [...row.slice(graph.plot.offset)]
    .map(char => char === ' ' ? 0 : char.codePointAt(0) - 0x2800));
  const expected = Array.from({ length: 5 }, () => Array(graph.plot.width).fill(0));
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  graph.points.forEach(({ x, y, bar }, i) => {
    assert.equal(bar, bars[i]);
    assert.ok(x >= 0 && x < graph.plot.width * 2); assert.ok(y >= 0 && y < 20);
    expected[Math.floor(y / 4)][Math.floor(x / 2)] |= bits[y % 4][x % 2];
  });
  assert.deepEqual(masks, expected); assert.equal(graph.points[117].y, 0);
  assert.match(graph.lines[0], /1000\.00/); assert.match(graph.lines[4], /101\.00/);
  assert.equal(graph.points[0].x, 0); assert.equal(graph.points.at(-1).x, graph.plot.width * 2 - 1);
  assert.ok(graph.aggregated > 0); assert.deepEqual(bars, original);
  const flat = priceChart(bars.map(bar => ({ ...bar, close: '12' })), 37, 5);
  assert.equal(flat.occupied, flat.plot.width * 2);
  assert.match(flat.lines.at(-2), new RegExp(`${flat.plotted} bars → ${flat.occupied} dots`));
  // Independent tiny oracle: x = 0,0,1,1,2,2,3,3 and y = 0,1,2,3,0,1,2,3.
  const tiny = priceChart(bars.slice(0, 8).map((bar, i) => ({ ...bar, close: String(4 - i % 4) })), 8, 1);
  assert.equal(tiny.lines[0].slice(tiny.plot.offset), '⢣⢣'); // bits 1+2+32+128 = 163 in each cell.
  assert.equal(tiny.plotted, 8); assert.equal(tiny.occupied, 8);
});

test('details show selected OHLC, previous close, volume, span, missing bars and backend-only archive delta', () => {
  const data = fixture(), bars = data.symbols[0].bars;
  assert.equal(formatPrice('12.3'), '12.30'); assert.equal(formatPrice('NaN'), '--');
  const details = summaryLines(data, 'SPY', '4', 58).join('\n');
  for (const text of ['Open 359.00', 'High 361.00', 'Low 358.00', 'Close 360.00',
    'Prev close 359.00', 'Volume 1000259', 'Missing 1 · filled 0', 'Mkt cap unknown · P/E unknown',
    'Archive Δ +7.13% · backend only', 'Price change, not total return', 'Calendar gaps: not_evaluated']) {
    assert.ok(details.includes(text), text);
  }
  const shorter = summaryLines(data, 'SPY', '1').join('\n');
  assert.ok(shorter.includes(`${bars.at(-21).date}  ${formatPrice(bars.at(-21).close)}`));
  assert.ok(shorter.includes(`${bars.at(-1).date}  ${formatPrice(bars.at(-1).close)}`));
  assert.match(shorter, /Archive Δ \+7.13% · backend only/); // Never relabeled as a 1M/daily return.
  data.summary[0].metric = 'total_return';
  assert.match(summaryLines(data, 'SPY').join(''), /Archive Δ unknown/);
  assert.match(summaryLines(null, 'SPY').join(''), /First --/);
  assert.match(summaryLines(fixture(1), 'SPY').join(''), /Prev close --/);
});

test('reference layout exposes bounded panes and disjoint controls at minimum, recommended and recording sizes', () => {
  for (const [width, height] of [[100, 30], [110, 32], [150, 43], [160, 42], [240, 60]]) {
    const box = marketLayout(width, height);
    assert.equal(box.narrow, false); assert.ok(box.top + box.rows < box.footer);
    for (const hit of box.controls) {
      assert.ok(hit.x >= 1 && hit.end < width && hit.y >= 1 && hit.bottom < height);
      assert.equal(hitTest(box.controls, hit.x, hit.y)?.id, hit.id);
      assert.equal(hitTest(box.controls, hit.end, hit.bottom)?.id, hit.id);
      for (const other of box.controls.filter(row => row !== hit)) {
        assert.ok(hit.end < other.x || other.end < hit.x || hit.bottom < other.y || other.bottom < hit.y);
      }
    }
    const panes = Object.entries(box.panels).filter(([name]) => name !== 'center').map(([, pane]) => pane);
    for (const pane of panes) {
      assert.ok(pane.x >= 1 && pane.end < width && pane.y >= 1 && pane.bottom < box.statusRow);
      for (const other of panes.filter(row => row !== pane)) {
        assert.ok(pane.end < other.x || other.end < pane.x || pane.bottom < other.y || other.bottom < pane.y);
      }
    }
    assert.equal(box.panels.command.height, 3); assert.equal(box.statusRow, height - 1);
    assert.equal(hitTest(box.controls, 0, 0), undefined);
  }
  const { panels, controls } = marketLayout(150, 43);
  assert.deepEqual(['watchlist', 'chart', 'signals'].map(name => panels[name].width), [47, 60, 39]);
  assert.deepEqual(['watchlist', 'chart', 'signals'].map(name => panels[name].height), [24, 20, 15]);
  assert.deepEqual(controls.filter(hit => ['fetch', 'reload', 'tab:chart', 'tab:prices', 'tab:provenance'].includes(hit.id))
    .map(({ id, x, y, width, height }) => [id, x, y, width, height]), [
    ['fetch', 3, 40, 9, 1], ['reload', 13, 40, 10, 1], ['tab:chart', 24, 40, 9, 1],
    ['tab:prices', 34, 40, 10, 1], ['tab:provenance', 45, 40, 10, 1],
  ]);
  for (const [width, height] of [[99, 30], [100, 29], [0, 0]]) {
    assert.equal(marketLayout(width, height).narrow, true);
    assert.deepEqual(marketLayout(width, height).controls, []);
  }
});

test('prices preserve raw volume; provenance retains complete hashes, URLs and limitations when wrapped', () => {
  const data = fixture(); data.symbols[0].bars[0].volume = '1234567890123';
  assert.ok(priceLines(data.symbols[0].bars, 120)[1].includes('1234567890123'));
  assert.ok(priceLines(data.symbols[0].bars, 66)[1].includes('1234567890123'));
  const compact = priceLines(data.symbols[0].bars, 37);
  assert.ok(compact[1].includes('1234567890123'));
  assert.match(compact[2], /O 100\.00 +H 102\.00 +L 99\.00/);
  assert.ok(compact.every(line => kit.stringWidth(line) <= 37));
  assert.ok(provenanceLines(null, 'SPY', 'Not loaded', 37).every(line => kit.stringWidth(line) <= 37));
  const lines = provenanceLines(data, 'SPY', 'test verification', 64), joined = lines.join('');
  assert.ok(lines.every(line => kit.stringWidth(line) <= 64));
  for (const text of [data.manifest.id, 'a'.repeat(64), data.manifest.request_urls.SPY,
    'not origin authenticity', 'AUDITABLE BACKTEST UNAVAILABLE', 'historic universe UNVERIFIED',
    'exchange_timezone', 'null_ohlcv', 'not_verified']) assert.ok(joined.includes(text), text);
});

test('archive notes keep short ID, collection UTC, selected date bounds and uncertainty separate from signals', () => {
  const data = fixture();
  for (const width of [24, 37, 60]) {
    const notes = notesLines(data, 'IWM', 'Manifest + raw SHA256 verified by backend reload', width);
    assert.ok(notes.every(line => kit.stringWidth(line) <= width));
    const text = notes.join('');
    for (const value of ['Archive 00000000', 'Collected UTC', data.manifest.collected_at,
      `From ${data.symbols[2].bars[0].date}`, `To   ${data.symbols[2].bars.at(-1).date}`,
      'SHA256: reload verified', 'Latest: may be incomplete', 'PIT/universe unverified',
      'Public redistribution unverified']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(notesLines(data, 'SPY', 'Raw saved by backend; R reload verifies SHA256', width).join(''), /reload verified/);
  }
  assert.match(notesLines(null, 'SPY', 'Not loaded').join(''), /Archive none/);
});

test('startup only reloads local archive; six-pane snapshot, honest unavailable AI and final footer marker', async t => {
  const { ui, term, backend } = setup(); t.after(() => ui.close()); await ui.ready;
  assert.deepEqual(backend.calls, [{ method: 'market.show', params: { store: path.resolve('market-test-root/.itt/market') } }]);
  for (const text of ['WATCHLIST', 'AGENT CALL', 'SPY | DAILY | Archive', 'DETAILS', 'SIGNALS', 'NOTES / ARCHIVE',
    'provider-adjusted', 'PIT/universe unverified', 'Collected UTC', '2026-09-10T12:00:00Z',
    'NOT CONNECTED', 'Natural language unavailable', FOOTER_MARKER, 'SHA256: reload verified']) {
    assert.ok(term.text().includes(text), text);
  }
  assert.equal(ui.keys, KEYS); assert.equal(ui.layout.width, 160); assert.equal(ui.state.lookback, '4');
  assert.ok(term.frames.at(-1).some(row => row.background === 'bgBlue'));
  assert.deepEqual(term.frames.at(-1).slice(-2).map(row => row.text), [FOOTER_MARKER, '[Esc Quit]']);
  assert.equal(term.frames.at(-1).at(-1).y, term.height - 1);
  const agent = term.screen(ui.layout.panels.agent), signals = term.screen(ui.layout.panels.signals);
  for (const provider of ['OpenAI', 'Azure OpenAI', 'GitHub Copilot']) assert.ok(agent.includes(provider));
  for (const symbol of SYMBOLS) assert.match(signals, new RegExp(`${symbol} +N/A`));
  assert.doesNotMatch(signals, /\d+%|BUY|SELL|HOLD|CONF/);
  assert.doesNotMatch(term.text(), /\bLIVE\b|\bBUY\b|\bSELL\b|\bHOLD\b/);
});

test('final rendered cells retain every border, bounded green graph and minimum-size required fields', async t => {
  const { ui, term } = setup(); t.after(() => ui.close()); await ui.ready;
  for (const [width, height] of [[100, 30], [110, 32], [150, 43], [240, 60]]) {
    term.width = width; term.height = height; term.emit('resize');
    for (const tab of ['c', 'p', 'i']) {
      await ui.action(tab);
      const panels = ui.layout.panels;
      const names = ['watchlist', 'agent', 'signals', 'notes', 'command', ...(tab === 'c' ? ['chart', 'details'] : ['center'])];
      for (const name of names) {
        const rect = panels[name], rows = term.screen(rect).split('\n');
        assert.equal(rows.length, rect.height);
        assert.ok(rows.every(row => kit.stringWidth(row) === rect.width), `${name} cell width`);
        assert.equal(rows[0][0], '┌'); assert.equal(rows[0].at(-1), '┐');
        assert.equal(rows.at(-1)[0], '└'); assert.equal(rows.at(-1).at(-1), '┘');
        assert.ok(rows.slice(1, -1).every(row => row[0] === '│' && row.at(-1) === '│'), `${name} side borders`);
      }
      // Wrapped terminal cells may split words; inspect content independently of borders.
      const notes = term.screen(panels.notes).split('\n').slice(1, -1)
        .map(row => row.slice(1, -1).trimEnd()).join('');
      assert.match(notes, /Latest: may be incomplete/); assert.match(notes, /PIT\/universe unverified/);
      assert.match(notes, /Public redistribution/);
      assert.match(term.screen(), /Natural language unavailable/);
      assert.ok(term.screen().includes(FOOTER_MARKER));
      if (tab === 'c') {
        const details = term.screen(panels.details);
        for (const value of ['Open 359.00', 'High 361.00', 'Low 358.00', 'Close 360.00',
          'Prev close 359.00', 'Volume 1000259', 'First 2025-01-01', 'Last  2025-09-17',
          'Missing 1 · filled 0', 'Mkt cap unknown · P/E unknown']) assert.ok(details.includes(value), value);
        const dots = term.frames.at(-1).filter(row => /[\u2801-\u28ff]/.test(row.text));
        assert.ok(dots.length > 0);
        assert.ok(dots.every(row => row.color === 'green' && row.x > panels.chart.x &&
          row.x + kit.stringWidth(row.text) <= panels.chart.end && row.y > panels.chart.y && row.y < panels.chart.bottom));
      }
    }
  }
});

test('watchlist price/delta come from backend summary; 1M selection cannot turn archive delta into a daily return', async t => {
  const data = fixture();
  data.summary[0].last_price = '123.456'; // Deliberately differs from the last closing bar (360).
  data.summary[1].pricechange_pct = '-2.125'; data.summary[2].pricechange_pct = null;
  const { ui, term, backend } = setup({ 'market.show': () => data }); t.after(() => ui.close()); await ui.ready;
  const before = term.screen(ui.layout.panels.watchlist);
  for (const text of ['SYMBOL', 'PRICE', 'ARCHIVE Δ', '123.46', '+7.13%', '-2.13%', 'unknown']) assert.ok(before.includes(text), text);
  assert.ok(term.frames.at(-1).some(row => row.text.trim() === '+7.13%' && row.color === 'green' && row.background === 'bgBlue'));
  assert.ok(term.frames.at(-1).some(row => row.text.trim() === 'unknown' && row.color === 'yellow'));
  await ui.action('1'); assert.equal(term.screen(ui.layout.panels.watchlist), before);
  assert.match(term.screen(ui.layout.panels.chart), /SPY \| DAILY \| 1M/);
  assert.match(term.screen(ui.layout.panels.chart), /21 bars →/);
  assert.match(term.screen(ui.layout.panels.details), /Close 360.00/);
  assert.equal(backend.calls.length, 1);
});

test('missing/invalid archive remains empty with Fetch; success is saved, R alone claims reload verification', async t => {
  let exists = false;
  const { ui, term, backend } = setup({ 'market.show': () => {
    if (!exists) throw Object.assign(new Error('SECRET path'), { code: 'input_rejected' });
    return fixture();
  }, 'market.fetch': () => { exists = true; return fixture(); } });
  t.after(() => ui.close()); await ui.ready;
  assert.equal(ui.state.ready, true); assert.equal(ui.state.snapshot, null);
  assert.match(term.text(), /NO READABLE MARKET DATA/); assert.match(term.text(), /\[F Fetch\]/);
  assert.ok(!term.text().includes('SECRET')); assert.ok(ui.state.error);
  click(term, ui, 'fetch'); await tick();
  assert.deepEqual(backend.calls[1], { method: 'market.fetch', params: {
    symbols: ['SPY', 'QQQ', 'IWM'], store: path.resolve('market-test-root/.itt/market') } });
  assert.ok(ui.state.snapshot); assert.equal(ui.state.error, '');
  assert.match(ui.state.verification, /R reload verifies/);
  click(term, ui, 'reload'); await tick();
  assert.equal(backend.calls[2].method, 'market.show'); assert.match(ui.state.verification, /verified by backend reload/);
});

test('watchlist click/UpDown, period keys/buttons, all tabs and bounded price/provenance scrolling', async t => {
  const { ui, term } = setup(); t.after(() => ui.close()); await ui.ready;
  term.emit('key', 'DOWN'); assert.equal(ui.state.selected, 1);
  click(term, ui, 'symbol:IWM'); assert.equal(ui.state.selected, 2);
  term.emit('key', 'DOWN'); assert.equal(ui.state.selected, 2);
  term.emit('key', 'UP'); assert.equal(ui.state.selected, 1);
  for (const key of ['1', '2', '3', '4']) {
    click(term, ui, `period:${key}`); assert.equal(ui.state.lookback, key);
  }
  term.emit('key', '1'); assert.equal(ui.state.lookback, '1');
  click(term, ui, 'tab:prices'); assert.equal(ui.state.tab, 'prices');
  term.emit('key', 'PAGE_DOWN'); assert.ok(ui.state.offset > 0);
  term.emit('key', 'PAGE_UP'); assert.equal(ui.state.offset, 0);
  term.emit('key', '4');
  term.emit('mouse', 'MOUSE_WHEEL_DOWN', { x: 80, y: 20 }); assert.equal(ui.state.offset, 3);
  term.emit('key', 'I'); assert.equal(ui.state.tab, 'provenance'); assert.equal(ui.state.offset, 0);
  term.emit('key', 'PAGE_DOWN'); assert.ok(ui.state.offset > 0);
  for (let i = 0; i < 10; i++) term.emit('key', 'PAGE_DOWN');
  const max = provenanceLines(ui.state.snapshot, 'QQQ', ui.state.verification, ui.layout.panelWidth).length - ui.layout.rows;
  assert.equal(ui.state.offset, Math.max(0, max));
  term.emit('mouse', 'MOUSE_WHEEL_UP', { x: 80, y: 20 }); assert.ok(ui.state.offset < max);
  click(term, ui, 'tab:chart'); assert.equal(ui.state.offset, 0);
  term.emit('key', 'PAGE_DOWN'); assert.equal(ui.state.offset, 0);
  term.emit('key', 'P'); assert.equal(ui.state.tab, 'prices');
  term.emit('key', 'C'); assert.equal(ui.state.tab, 'chart');
  term.emit('mouse', 'MOUSE_WHEEL_UP', { x: 4, y: 11 }); assert.equal(ui.state.selected, 0);
});

test('fetch waits for genuine backend completion, prevents duplicate RPCs, allows navigation and clears on failure', async t => {
  const pending = deferred();
  const { ui, term, backend } = setup({ 'market.fetch': () => pending.promise });
  t.after(() => ui.close()); await ui.ready;
  const work = ui.action('f'); assert.match(ui.state.busy, /waiting for network/);
  assert.match(term.text(), /waiting for network/); assert.ok(!/\b\d+% complete/.test(term.text()));
  await ui.action('f'); await ui.action('r'); assert.equal(backend.calls.length, 2);
  term.emit('key', 'DOWN'); term.emit('key', 'I'); assert.equal(ui.state.selected, 1);
  pending.reject(Object.assign(new Error('SECRET provider body'), { code: 'input_rejected' })); await work;
  assert.equal(ui.state.busy, ''); assert.equal(ui.state.snapshot, null); assert.ok(ui.state.error);
  assert.match(term.text(), /No readable market archive/); assert.ok(!term.text().includes('SECRET'));
  assert.equal(backend.calls.length, 2);
});

test('failed R verification never leaves old prices displayed or silently falls back', async t => {
  let calls = 0;
  const { ui, term, backend } = setup({ 'market.show': () => {
    if (++calls === 1) return fixture();
    throw Object.assign(new Error('hash mismatch'), { code: 'input_rejected' });
  } });
  t.after(() => ui.close()); await ui.ready; await ui.action('r');
  assert.equal(ui.state.snapshot, null); assert.match(ui.state.verification, /No verified archive/);
  assert.match(term.text(), /First --/); assert.equal(backend.calls.length, 2);
  assert.ok(backend.calls.every(call => call.method === 'market.show'));
  assert.doesNotMatch(term.screen(ui.layout.panels.watchlist), /360\.00|7\.13%/);
  assert.doesNotMatch(term.screen(ui.layout.panels.chart), /[\u2801-\u28ff]/);
  for (const symbol of SYMBOLS) assert.ok(term.screen(ui.layout.panels.watchlist).includes(symbol));
});

test('fixed three-symbol display rejects missing, duplicate or substituted instruments and summaries', async t => {
  const mutations = [
    data => { data.symbols.pop(); }, data => { data.summary.pop(); },
    data => { data.symbols[2].symbol = 'QQQ'; }, data => { data.summary[2].symbol = 'QQQ'; },
    data => { data.symbols[2].symbol = 'MSFT'; }, data => { data.summary[2].symbol = 'MSFT'; },
    data => { data.symbols[1].bars = [null]; }, data => { data.summary[1] = null; },
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data);
    const { ui, term, backend } = setup({ 'market.show': () => data }); t.after(() => ui.close()); await ui.ready;
    assert.equal(ui.state.snapshot, null); assert.ok(ui.state.error); assert.equal(backend.calls.length, 1);
    assert.match(term.text(), /NO READABLE MARKET DATA/);
    assert.doesNotMatch(term.screen(ui.layout.panels.watchlist), /360\.00|7\.13%|MSFT/);
    assert.doesNotMatch(term.text(), /[\u2801-\u28ff]/);
  }
  const data = fixture(); data.symbols.reverse(); data.summary.reverse();
  const { ui, term } = setup({ 'market.show': () => data }); t.after(() => ui.close()); await ui.ready;
  assert.ok(ui.state.snapshot); assert.match(term.screen(ui.layout.panels.chart), /SPY \| DAILY/);
});

test('wheel only selects watchlist or scrolls center; borders, notes, commands and blank clicks are inert', async t => {
  const { ui, term } = setup(); t.after(() => ui.close()); await ui.ready; await ui.action('p');
  const { watchlist, notes, center, command } = ui.layout.panels;
  for (const point of [{ x: watchlist.x, y: 5 }, { x: center.end, y: 5 },
    { x: notes.x + 1, y: notes.y + 1 }, { x: command.x + 1, y: command.y + 1 }]) {
    term.emit('mouse', 'MOUSE_WHEEL_DOWN', point);
    assert.equal(ui.state.selected, 0); assert.equal(ui.state.offset, 0);
  }
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: watchlist.x + 2, y: 9 });
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', undefined);
  assert.equal(ui.state.selected, 0);
  term.emit('mouse', 'MOUSE_WHEEL_DOWN', { x: watchlist.x + 2, y: 6 }); assert.equal(ui.state.selected, 1);
  term.emit('mouse', 'MOUSE_WHEEL_DOWN', { x: center.x + 2, y: 6 }); assert.equal(ui.state.offset, 3);
  click(term, ui, 'exit'); await ui.done;
});

test('resize keeps writes in bounds, safe text and footer at minimum size; narrow screen ignores clicks', async t => {
  const data = fixture(); data.manifest.provider = '\x1b]52;SECRET\x07日本語 %s ^r';
  const { ui, term } = setup({ 'market.show': () => data }); t.after(() => ui.close()); await ui.ready;
  for (const [width, height] of [[100, 30], [160, 42], [99, 29], [60, 12], [2, 2], [0, 0], [100, 30]]) {
    term.width = width; term.height = height; term.emit('resize');
    if (width >= 100 && height >= 30) {
      assert.match(term.text(), /Tokens: no recorded calls/);
      for (const key of ['p', 'i', 'c']) await ui.action(key);
    } else assert.equal(ui.controls.length, 0);
  }
  term.width = 60; term.height = 20; term.emit('resize');
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 3, y: 16 }); assert.equal(ui.state.selected, 0);
  term.emit('key', 'ESCAPE'); await ui.done;
});

test('EOF during initial load restores terminal, awaits backend close once, ignores late response', async () => {
  const pending = deferred(), closing = deferred();
  const { ui, term, backend, input, signals } = setup({ 'market.show': () => pending.promise, close: () => closing.promise });
  input.emit('end'); let finished = false; ui.done.then(() => { finished = true; });
  assert.equal(backend.closed, 1); assert.equal(ui.close(), ui.done);
  assert.equal(term.listenerCount('key'), 0); assert.equal(term.listenerCount('mouse'), 0);
  assert.equal(term.listenerCount('resize'), 0); assert.equal(backend.listenerCount('failure'), 0);
  assert.equal(input.listenerCount('end'), 0); assert.equal(input.listenerCount('close'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.deepEqual(term.modes.slice(-3), [['grabInput', false], ['hideCursor', false], ['fullscreen', false]]);
  const frames = term.frames.length; pending.resolve(fixture()); await ui.ready; await tick();
  assert.equal(ui.state.snapshot, null); assert.equal(term.frames.length, frames); assert.equal(finished, false);
  closing.resolve(); await ui.done; assert.equal(finished, true); assert.equal(backend.closed, 1);
});

test('startup factory, unsupported RPC, malformed result and connection failures are visible and redacted', async t => {
  const term = fakeTerm(), signals = new EventEmitter(), input = new EventEmitter(); let factoryRoot;
  const ui = startMarketUI({ term, signals, input, root: path.resolve('market-factory-root'), backendFactory({ root }) {
    factoryRoot = root; throw Object.assign(new Error('SECRET'), { code: 'missing_interpreter' });
  } });
  t.after(() => ui.close()); await ui.ready;
  assert.equal(factoryRoot, path.resolve('market-factory-root')); assert.equal(ui.state.ready, false);
  assert.match(ui.state.error, /\.venv\b/); assert.ok(!term.text().includes('SECRET'));
  for (const response of [() => { throw Object.assign(new Error('SECRET'), { code: 'method_not_found' }); },
    () => ({}), () => ({ manifest: {}, symbols: [null], summary: [] }),
    () => ({ manifest: {}, symbols: [{ symbol: 'SPY', bars: [null] }], summary: [] })]) {
    const run = setup({ 'market.show': response }); t.after(() => run.ui.close()); await run.ui.ready;
    assert.ok(run.ui.state.error); assert.equal(run.ui.state.snapshot, null);
  }
  const run = setup(); t.after(() => run.ui.close()); await run.ui.ready;
  run.backend.emit('failure', Object.assign(new Error('SECRET'), { code: 'exited' }));
  assert.equal(run.ui.state.ready, false); assert.equal(run.ui.state.snapshot, null);
  assert.ok(run.ui.state.error); assert.ok(!run.term.text().includes('SECRET'));
  const count = run.backend.calls.length; await run.ui.action('f'); assert.equal(run.backend.calls.length, count);
  run.signals.emit('SIGTERM'); await run.ui.done; assert.equal(run.backend.closed, 1);
});

test('Ctrl-C and close rejection still restore modes and do not leak listeners or reject shutdown', async () => {
  const { ui, term, backend } = setup({ close: () => Promise.reject(new Error('SECRET')) }); await ui.ready;
  term.emit('key', 'CTRL_C'); await ui.close();
  assert.equal(backend.closed, 1); assert.equal(term.listenerCount('key'), 0);
  assert.equal(ui.state.error, 'Operation failed (details redacted).');
});