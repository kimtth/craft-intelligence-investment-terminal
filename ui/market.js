import kit from 'terminal-kit';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackend, ROOT, safeError } from './backend.js';
import { sanitize, fit, wrap } from './index.js';

export const SYMBOLS = Object.freeze(['SPY', 'QQQ', 'IWM']);
export const LOOKBACKS = Object.freeze([
  Object.freeze({ key: '1', label: '1M', bars: 21 }),
  Object.freeze({ key: '2', label: '3M', bars: 63 }),
  Object.freeze({ key: '3', label: '6M', bars: 126 }),
  Object.freeze({ key: '4', label: 'Archive', bars: null }),
]);
export const KEYS = Object.freeze({ fetch: 'f', reload: 'r', chart: 'c', prices: 'p',
  provenance: 'i', lookbacks: Object.freeze(['1', '2', '3', '4']),
  previous: 'UP', next: 'DOWN', pageUp: 'PAGE_UP', pageDown: 'PAGE_DOWN', exit: 'ESCAPE' });
const tabKeys = { c: 'chart', p: 'prices', i: 'provenance' };
// Stable last-row marker for recorders; this describes snapshot mode, not a live feed.
export const FOOTER_MARKER = 'SNAPSHOT Yahoo | AI offline | Tokens: no recorded calls | Cost: unknown';
const finite = value => (typeof value === 'number' ||
  (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)))
  && Number.isFinite(Number(value));

// Number is used for graph coordinates and display rounding only, never returns/accounting.
export const formatPrice = value => finite(value) ? Number(value).toFixed(2) : '--';
export function filterBars(bars, lookback = '4') {
  if (!Array.isArray(bars)) return [];
  const period = LOOKBACKS.find(item => item.key === String(lookback));
  if (!period) return [];
  return period.bars === null ? bars.slice() : bars.slice(-period.bars);
}
export function sampleBars(bars, count) {
  count = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!Array.isArray(bars) || !count) return [];
  if (bars.length <= count) return bars.slice();
  if (count === 1) return [bars.at(-1)];
  return Array.from({ length: count }, (_, i) => bars[Math.round(i * (bars.length - 1) / (count - 1))]);
}

// Rasterize EVERY close into 2x4 Braille subpixels. Collisions merge dots, not prices.
// No interpolation, calendar fill, adjusted-close reconstruction, or financial calculations.
export function priceChart(bars, width = 80, height = 12) {
  width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  height = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 12;
  const unavailable = text => ({ lines: [fit(text, width)], samples: [], points: [],
    plotted: 0, occupied: 0, aggregated: 0, plot: null });
  if (!Array.isArray(bars) || !bars.length) return unavailable('No archived prices. Use F Fetch.');
  if (bars.some(bar => !bar || typeof bar.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || !finite(bar.close) || Number(bar.close) <= 0)) {
    return unavailable('Price chart unavailable: invalid archived samples.');
  }
  const values = bars.map(bar => Number(bar.close));
  const low = values.reduce((a, b) => Math.min(a, b));
  const high = values.reduce((a, b) => Math.max(a, b));
  const labelWidth = Math.min(12, Math.max(formatPrice(low).length, formatPrice(high).length));
  const columns = width - labelWidth - 2;
  if (columns < 2) return unavailable('Chart too narrow.');
  const samples = bars.slice(), pixels = new Set();
  const grid = Array.from({ length: height }, () => Array(columns).fill(0));
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  const points = samples.map((bar, i) => {
    const x = samples.length === 1 ? 0 : Math.round(i * (columns * 2 - 1) / (samples.length - 1));
    const y = high === low ? Math.floor((height * 4 - 1) / 2) :
      Math.max(0, Math.min(height * 4 - 1,
        Math.round((high - Number(bar.close)) / (high - low) * (height * 4 - 1))));
    grid[Math.floor(y / 4)][Math.floor(x / 2)] |= bits[y % 4][x % 2];
    pixels.add(`${x},${y}`);
    return { x, y, bar };
  });
  const ticks = new Set([0, Math.round((height - 1) / 3), Math.round(2 * (height - 1) / 3), height - 1]);
  const lines = grid.map((row, i) => {
    // Intermediate labels are numerical axis ticks, NOT additional closing samples.
    const label = ticks.has(i) ? formatPrice(high - (high - low) * i / Math.max(1, height - 1)) : '';
    return `${fit(label, labelWidth).padStart(labelWidth)} ${ticks.has(i) ? '┤' : '│'}${row.map(mask =>
      mask ? String.fromCodePoint(0x2800 + mask) : ' ').join('')}`;
  });
  lines.push(`${' '.repeat(labelWidth + 1)}└${'─'.repeat(columns)}`);
  const dates = Array(width).fill(' ');
  const labels = width >= 32 ? [[0, bars[0].date], [Math.floor((width - 10) / 2), bars[Math.floor((bars.length - 1) / 2)].date],
    [width - 10, bars.at(-1).date]] : [[0, bars[0].date], [Math.max(11, width - 10), bars.at(-1).date]];
  for (const [start, label] of labels) [...label].forEach((char, i) => { if (start + i < width) dates[start + i] = char; });
  lines.push(dates.join(''));
  lines.push(fit(`${bars.length} bars → ${pixels.size} dots (${bars.length - pixels.size} merged)`, width));
  lines.push(fit('Bar-spaced · no interpolation', width));
  return { lines, samples, points, plotted: bars.length, occupied: pixels.size,
    aggregated: bars.length - pixels.size, plot: { offset: labelWidth + 2, width: columns, height } };
}

export function marketLayout(width, height) {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  height = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  const narrow = width < 100 || height < 30;
  // One-cell gutters; reserve the final terminal column and row against autowrap.
  // At 150x43 the panes are 47 / 60 / 39 columns, matching the supplied reference.
  const available = Math.max(0, width - 4), body = Math.max(0, height - 5);
  const leftWidth = Math.round(available * .32), centerWidth = Math.round(available * .41);
  const rightWidth = available - leftWidth - centerWidth;
  const rect = (x, y, w, h) => ({ x, y, width: w, height: h, end: x + w - 1, bottom: y + h - 1 });
  const split = (x, w, fraction, minimumBottom = 0) => {
    const h = Math.min(Math.round(body * fraction), body - minimumBottom - 1);
    return [rect(x, 1, w, h), rect(x, h + 2, w, body - h - 1)];
  };
  const [watchlist, agent] = split(1, leftWidth, .62);
  const [chart, details] = split(leftWidth + 2, centerWidth, .53, 12);
  const [signals, notes] = split(leftWidth + centerWidth + 3, rightWidth, .40);
  const center = rect(chart.x, 1, centerWidth, body);
  const command = rect(1, body + 1, width - 2, 3);
  const box = { width, height, narrow, left: 2, right: center.x + 1, top: 3, footer: command.y,
    rows: Math.max(0, body - 3), panelWidth: Math.max(0, centerWidth - 2),
    sidebarWidth: Math.max(0, leftWidth - 2), controls: [],
    panels: { watchlist, agent, chart, details, signals, notes, center, command }, statusRow: height - 1 };
  if (narrow) return box;
  const add = (id, x, y, label, action, controlHeight = 1, controlWidth = label.length) => {
    box.controls.push({ id, x, y, width: controlWidth, height: controlHeight,
      end: x + controlWidth - 1, bottom: y + controlHeight - 1, label, ...action });
  };
  let x = 3;
  for (const [id, key, label] of [['fetch', 'f', '[F Fetch]'], ['reload', 'r', '[R Verify]']]) {
    add(id, x, command.y + 1, label, { key }); x += label.length + 1;
  }
  for (const [key, tab] of Object.entries(tabKeys)) {
    const label = `[${key.toUpperCase()} ${{ chart: 'Chart', prices: 'Prices', provenance: 'Source' }[tab]}]`;
    add(`tab:${tab}`, x, command.y + 1, label, { key }); x += label.length + 1;
  }
  add('exit', width - 12, height - 1, '[Esc Quit]', { key: 'escape' });
  x = box.right;
  for (const period of LOOKBACKS) {
    const label = `[${period.key} ${period.label}]`;
    add(`period:${period.key}`, x, 2, label, { key: period.key }); x += label.length + 1;
  }
  SYMBOLS.forEach((symbol, index) => add(`symbol:${symbol}`, 2, 5 + index,
    symbol, { index }, 1, box.sidebarWidth));
  return box;
}
export function hitTest(controls, x, y) {
  return controls.find(hit => x >= hit.x && x <= hit.end && y >= hit.y && y <= hit.bottom);
}

function priceDelta(snapshot, symbol) {
  const row = snapshot?.summary?.find(item => item.symbol === symbol);
  if (row?.metric !== 'price_change_not_investment_return' || !finite(row.pricechange_pct)) return 'unknown';
  return `${Number(row.pricechange_pct) > 0 ? '+' : ''}${formatPrice(row.pricechange_pct)}%`;
}

export function summaryLines(snapshot, symbol, lookback = '4', width = 80) {
  const item = snapshot?.symbols?.find(item => item.symbol === symbol);
  const bars = filterBars(item?.bars, lookback);
  const first = bars[0], last = bars.at(-1);
  const pair = (left, right) => `${fit(left, Math.floor(width / 2)).padEnd(Math.floor(width / 2))}${right}`;
  const missing = item?.missing_bars;
  return [
    `${symbol} · ${item?.currency ?? 'unknown'} · ${item?.exchange ?? 'unknown'}`,
    pair(`Open ${formatPrice(last?.open)}`, `High ${formatPrice(last?.high)}`),
    pair(`Low ${formatPrice(last?.low)}`, `Close ${formatPrice(last?.close)}`),
    `Prev close ${formatPrice(item?.bars?.at(-2)?.close)}`,
    `Volume ${last?.volume ?? 'unknown'}`,
    `First ${first?.date ?? '--'}  ${formatPrice(first?.close)}`,
    `Last  ${last?.date ?? '--'}  ${formatPrice(last?.close)}`,
    `Missing ${missing?.skipped_count ?? '?'} · filled ${missing?.filled_count ?? '?'}`,
    'Mkt cap unknown · P/E unknown',
    `Archive Δ ${priceDelta(snapshot, symbol)} · backend only`,
    'Price change, not total return',
    `Calendar gaps: ${missing?.calendar_gaps ?? 'unknown'}`,
    'Date basis / events: I Source',
  ].map(line => fit(line, width));
}

export function priceLines(bars, width = 80) {
  if (!bars?.length) return ['No archived prices. Use F Fetch.'];
  // Narrow center panes use two lines per bar instead of silently losing volume.
  if (width < 66) return [fit('DATE        CLOSE       VOLUME', width),
    ...bars.flatMap(bar => [fit(`${sanitize(bar.date)}  ${formatPrice(bar.close)}  ${bar.volume ?? 'unknown'}`, width),
      fit(`O ${formatPrice(bar.open)}  H ${formatPrice(bar.high)}  L ${formatPrice(bar.low)}`, width)])];
  const cell = (value, size) => fit(value, size).padStart(size);
  const priceWidth = Math.max(5, Math.min(10, Math.floor((width - 28) / 4)));
  return [fit(`DATE       ${['OPEN', 'HIGH', 'LOW', 'CLOSE']
    .map(label => cell(label, priceWidth)).join(' ')} ${cell('VOLUME', 13)}`, width),
    ...bars.map(bar => fit(`${sanitize(bar.date)} ${['open', 'high', 'low', 'close']
      .map(field => cell(formatPrice(bar[field]), priceWidth)).join(' ')} ${cell(bar.volume, 13)}`, width))];
}

export function provenanceLines(snapshot, symbol, verification, width = 80) {
  if (!snapshot) return ['No readable market archive.', 'F Fetch saves raw provider responses automatically.',
    'R Reload verifies saved bytes; errors never trigger synthetic data.'].flatMap(line => wrap(line, Math.max(1, width)));
  const manifest = snapshot.manifest, item = snapshot.symbols.find(row => row.symbol === symbol);
  const lines = [
    'ARCHIVE / BYTE INTEGRITY', `Archive ID: ${manifest.id}`, `Source: ${manifest.provider}`,
    `Collected UTC: ${manifest.collected_at}`, `Verification: ${verification}`,
    'R rereads latest pointer, verifies manifest + raw SHA256, and normalizes raw again.',
    'Hashes detect damage, not origin authenticity or an external audit.',
    'RAW SHA256 / archived file names',
    ...Object.entries(manifest.raw_sha256 ?? {}).flatMap(([name, hash]) => [name, String(hash)]),
    manifest.requested_bounds
      ? `SOURCE REQUESTS (${manifest.requested_bounds.start} — ${manifest.requested_bounds.end}, inclusive / 1d)`
      : 'SOURCE REQUESTS (legacy 1y / 1d; explicit dates not recorded)',
    ...Object.entries(manifest.request_urls ?? {}).flatMap(([name, url]) => [name, String(url)]),
    'INTERPRETATION / LIMITS',
    `Price basis: ${manifest.price_basis}`,
    'Raw close may be provider-adjusted; not a total-return series.',
    'PIT (historical availability) UNVERIFIED; historic universe UNVERIFIED.',
    'AUDITABLE BACKTEST UNAVAILABLE. No research or orders on real data.',
    `Current archive not PIT: ${manifest.current_archive_not_pit}`,
    `Historical universe verified: ${manifest.historical_universe_verified}`,
    `External audit: ${manifest.external_audit}`,
    `Latest bar may be incomplete: ${manifest.latestbar_may_be_incomplete}`,
    `Rights: ${JSON.stringify(manifest.rights)}`,
    `SELECTED INSTRUMENT: ${symbol}`,
  ];
  if (item) lines.push(`Currency: ${item.currency} | Exchange: ${item.exchange}`,
    `Exchange timezone: ${item.timezone}`, `Date basis: ${item.date_basis}`,
    `Missing bars: ${JSON.stringify(item.missing_bars)}`,
    `Corporate events (provider, not simulated): ${JSON.stringify(item.events)}`);
  return lines.flatMap(line => wrap(line, Math.max(1, width)));
}

export function notesLines(snapshot, symbol, verification, width = 36) {
  const item = snapshot?.symbols?.find(row => row.symbol === symbol), manifest = snapshot?.manifest;
  const bars = item?.bars ?? [];
  return [
    `Archive ${manifest?.id ? sanitize(manifest.id).slice(0, 8) : 'none'}`,
    'Collected UTC', `${manifest?.collected_at ?? 'unknown'}`,
    `From ${bars[0]?.date ?? '--'}`,
    `To   ${bars.at(-1)?.date ?? '--'}`,
    snapshot ? (verification.includes('verified by backend reload') ? 'SHA256: reload verified' : 'Saved; R verifies SHA256') : 'No verified archive',
    'Latest: may be incomplete',
    'PIT/universe unverified',
    'Public redistribution unverified',
    'I Source: full provenance',
    'Close may be provider-adjusted',
    'No auditable backtest / orders',
  ].flatMap(line => wrap(line, Math.max(1, width)));
}

// Python owns network, normalization, Decimal metrics, raw saves and SHA256 verification.
// Only these two market RPCs are permitted here; there is no research/order path.
export function startMarketUI({ term = kit.terminal, backend, backendFactory = createBackend,
  root = ROOT, signals = process, input = term.stdin ?? process.stdin } = {}) {
  const store = path.join(root, '.itt/market');
  const state = { snapshot: null, selected: 0, tab: 'chart', lookback: '4', offset: 0,
    ready: false, busy: '', error: '', verification: 'Not loaded', status: 'Opening market archive' };
  let stopped = false, closing = false, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const currentSymbol = () => SYMBOLS[state.selected];
  const currentBars = () => filterBars(state.snapshot?.symbols?.find(item => item.symbol === currentSymbol())?.bars, state.lookback);
  const box = () => marketLayout(term.width, term.height);
  function content() {
    const bounds = box();
    if (state.tab === 'provenance') return provenanceLines(state.snapshot, currentSymbol(), state.verification, bounds.panelWidth);
    if (state.tab === 'prices') return priceLines(currentBars(), bounds.panelWidth);
    return priceChart(currentBars(), bounds.panelWidth, Math.max(1, bounds.panels.chart.height - 7)).lines;
  }
  function draw() {
    if (stopped) return;
    const bounds = box();
    // Reserve the final column and row: never cause terminal autowrap/scroll at bottom right.
    const put = (x, y, text, color = 'white', width = bounds.width - x, background = 'bgBlack') => {
      if (x < 1 || y < 1 || x >= bounds.width || y >= bounds.height) return;
      const visible = fit(text, Math.max(0, Math.min(width, bounds.width - x)));
      if (!visible) return;
      term.moveTo(x, y); term[background][color].noFormat(visible);
    };
    term.bgBlack(); term.clear();
    if (bounds.narrow) {
      put(1, 1, 'ITT / SNAPSHOT Yahoo', 'cyan');
      put(1, 2, 'Resize to at least 100 x 30. Esc / Ctrl-C exits.', 'yellow');
      put(1, 3, 'Recommended 110 x 32 or larger.', 'white');
      if (bounds.height > 9) put(1, 5, state.error || state.busy, 'yellow');
      if (bounds.height >= 9) put(1, bounds.statusRow, FOOTER_MARKER, 'yellow');
      term.styleReset(); return;
    }
    const { watchlist, agent, chart, details, signals: signalPanel, notes, center, command } = bounds.panels;
    const frame = (rect, title) => {
      put(rect.x, rect.y, `┌${'─'.repeat(rect.width - 2)}┐`, 'cyan', rect.width);
      for (let y = rect.y + 1; y < rect.bottom; y++) {
        put(rect.x, y, '│', 'blue', 1); put(rect.end, y, '│', 'blue', 1);
      }
      put(rect.x, rect.bottom, `└${'─'.repeat(rect.width - 2)}┘`, 'blue', rect.width);
      put(rect.x + 2, rect.y, ` ${title} `, 'white', rect.width - 4);
    };
    const line = (rect, offset, text, color = 'white') => {
      if (offset >= 0 && offset < rect.height - 2) put(rect.x + 1, rect.y + 1 + offset, text, color, rect.width - 2);
    };
    frame(watchlist, 'WATCHLIST'); frame(agent, 'AGENT CALL');
    frame(signalPanel, 'SIGNALS'); frame(notes, 'NOTES / ARCHIVE');
    frame(command, 'COMMAND · Natural language unavailable');
    const priceWidth = watchlist.width - 22;
    line(watchlist, 0, `${'SYMBOL'.padEnd(8)}${'PRICE'.padStart(priceWidth)} ${'ARCHIVE Δ'.padStart(11)}`);
    line(watchlist, 2, 'ETFs / archived close', 'cyan');
    for (const control of bounds.controls.filter(hit => hit.index !== undefined)) {
      const selected = control.index === state.selected, background = selected ? 'bgBlue' : 'bgBlack';
      const summary = state.snapshot?.summary?.find(row => row.symbol === control.label);
      const delta = priceDelta(state.snapshot, control.label);
      put(control.x, control.y, ' '.repeat(control.width), 'white', control.width, background);
      put(control.x, control.y, `${selected ? '›' : ' '} ${control.label}`, 'white', 8, background);
      put(control.x + 8, control.y, formatPrice(summary?.last_price).padStart(priceWidth), 'white', priceWidth, background);
      put(control.x + 9 + priceWidth, control.y, delta.padStart(11),
        delta === 'unknown' ? 'yellow' : Number(summary.pricechange_pct) > 0 ? 'green' : 'white', 11, background);
    }
    ['3 ETFs · no synthetic fallback', 'Archive Δ: backend price change', 'Not daily / not total return',
      '↑↓ / click: select symbol', '1–4: 21 / 63 / 126 / all bars', 'F fetch · R verify saved bytes'].forEach((text, i) =>
      line(watchlist, 8 + i, text, i === 1 ? 'cyan' : 'white'));
    ['NOT CONNECTED', 'Provider targets (not wired):', 'OpenAI', 'Azure OpenAI', 'GitHub Copilot',
      'No recorded agent calls', 'No generated recommendation', 'Natural language unavailable'].forEach((text, i) =>
      line(agent, i, text, i === 0 ? 'yellow' : 'white'));
    line(signalPanel, 0, 'SYMBOL    STATUS', 'white');
    SYMBOLS.forEach((symbol, index) => line(signalPanel, 2 + index, `${symbol.padEnd(10)}N/A`, 'yellow'));
    line(signalPanel, 6, 'No signal engine connected', 'yellow');
    notesLines(state.snapshot, currentSymbol(), state.verification, notes.width - 2).forEach((text, i) =>
      line(notes, i, text, /unverified|incomplete|No verified/.test(text) ? 'yellow' : 'white'));

    if (state.tab === 'chart') {
      const period = LOOKBACKS.find(item => item.key === state.lookback);
      frame(chart, `${currentSymbol()} | DAILY | ${period.label}`); frame(details, 'DETAILS');
      summaryLines(state.snapshot, currentSymbol(), state.lookback, details.width - 2).forEach((text, i) =>
        line(details, i, text, /unknown|Missing|gaps/.test(text) ? 'yellow' : 'white'));
      if (state.snapshot) {
        const graph = priceChart(currentBars(), bounds.panelWidth, chart.height - 7);
        graph.lines.forEach((text, i) => {
          if (graph.plot && i < graph.plot.height) {
            // Gray numerical axis, vivid green price dots; no connecting segments.
            line(chart, i + 1, text.slice(0, graph.plot.offset));
            put(chart.x + 1 + graph.plot.offset, chart.y + 2 + i,
              text.slice(graph.plot.offset), 'green', graph.plot.width);
          } else line(chart, i + 1, text, graph.plot ? 'white' : 'yellow');
        });
      } else {
        ['NO READABLE MARKET DATA', 'F Fetch: Yahoo → raw archive', 'No synthetic fallback'].forEach((text, i) => line(chart, i + 2, text, 'yellow'));
      }
    } else {
      frame(center, `${currentSymbol()} | ${state.tab === 'prices' ? 'PRICES / DAILY' : 'SOURCE / PROVENANCE'}`);
      const lines = content(); state.offset = Math.min(state.offset, Math.max(0, lines.length - bounds.rows));
      lines.slice(state.offset, state.offset + bounds.rows).forEach((text, i) => line(center, i + 1, text));
    }
    const count = state.tab === 'chart' ? 0 : content().length;
    const nav = `↑↓ select · 1–4 period · PgUp/PgDn/wheel scroll${count ? ` · Rows ${state.offset + 1}–${Math.min(state.offset + bounds.rows, count)}/${count}` : ''}`;
    put(3, command.bottom, ` ${state.error ? `ERROR: ${state.error}` : state.busy || nav} `,
      state.error || state.busy ? 'yellow' : 'white', command.width - 4);
    for (const control of bounds.controls.filter(hit => hit.index === undefined && hit.id !== 'exit')) {
      const active = tabKeys[control.key] === state.tab || control.key === state.lookback;
      put(control.x, control.y, control.label, active ? 'white' : 'cyan', control.width, active ? 'bgBlue' : 'bgBlack');
    }
    // Last-row marker and Quit are painted last for recorder frame detection.
    put(2, bounds.statusRow, FOOTER_MARKER, 'white', bounds.width - 15);
    const exit = bounds.controls.find(hit => hit.id === 'exit');
    put(exit.x, exit.y, exit.label, 'cyan', exit.width);
    term.styleReset();
  }
  function report(error) {
    if (stopped) return;
    state.snapshot = null; state.offset = 0; state.verification = 'No verified archive displayed';
    state.error = error?.code === 'method_not_found' ? 'Market RPC unavailable in this backend.' : safeError(error);
    state.status = 'No readable market data; no synthetic fallback.'; draw();
  }
  function onFailure(error) { state.ready = false; report(error); }
  async function request(kind) {
    if (stopped || !state.ready || state.busy) return;
    state.busy = kind === 'fetch' ? 'Fetching Yahoo Finance; waiting for network + raw archive save.' :
      'Reloading archive; verifying manifest and raw SHA256 in backend.';
    state.error = ''; draw();
    try {
      const result = await backend.request(`market.${kind === 'fetch' ? 'fetch' : 'show'}`,
        kind === 'fetch' ? { symbols: [...SYMBOLS], store } : { store });
      if (stopped || !state.ready) return;
      // Guard display structure only. Financial validation and hash checks remain in Python.
      if (!result?.manifest || typeof result.manifest !== 'object' ||
          !Array.isArray(result.symbols) || !Array.isArray(result.summary) ||
          result.symbols.length !== SYMBOLS.length || result.summary.length !== SYMBOLS.length ||
          SYMBOLS.some(symbol => result.symbols.filter(item => item?.symbol === symbol).length !== 1 ||
            result.summary.filter(row => row?.symbol === symbol).length !== 1) ||
          result.symbols.some(item => !item || typeof item.symbol !== 'string' ||
            !Array.isArray(item.bars) || item.bars.some(bar => !bar || typeof bar.date !== 'string')) ||
          result.summary.some(row => !row || typeof row.symbol !== 'string')) {
        throw Object.assign(new Error('Invalid market display structure'), { code: 'input_rejected' });
      }
      state.snapshot = result; state.offset = 0;
      state.verification = kind === 'fetch' ? 'Raw saved by backend; R reload verifies SHA256' :
        'Manifest + raw SHA256 verified by backend reload';
      state.status = kind === 'fetch' ? 'Fetch complete. Raw responses saved automatically; no synthetic fallback.' :
        'Saved archive loaded. Byte integrity checked; not an external audit.';
    } catch (error) { report(error); }
    finally { state.busy = ''; draw(); }
  }
  function select(index) {
    state.selected = Math.max(0, Math.min(SYMBOLS.length - 1, index)); state.offset = 0; draw();
  }
  function scroll(delta) {
    if (state.tab === 'chart') return;
    state.offset = Math.max(0, Math.min(Math.max(0, content().length - box().rows), state.offset + delta)); draw();
  }
  async function action(key) {
    if (stopped) return;
    key = String(key).toLowerCase();
    if (['escape', 'esc', 'ctrl_c', 'q'].includes(key)) return close();
    if (box().narrow) return;
    if (tabKeys[key]) { state.tab = tabKeys[key]; state.offset = 0; draw(); }
    else if (LOOKBACKS.some(period => period.key === key)) { state.lookback = key; state.offset = 0; draw(); }
    else if (key === 'f' || key === 'r') await request(key === 'f' ? 'fetch' : 'show');
  }
  function onKey(key) {
    if (['ESCAPE', 'CTRL_C'].includes(key)) { void close(); return; }
    if (box().narrow || stopped) return;
    if (key === 'UP' || key === 'DOWN') select(state.selected + (key === 'UP' ? -1 : 1));
    else if (key === 'PAGE_UP' || key === 'PAGE_DOWN') scroll((key === 'PAGE_UP' ? -1 : 1) * box().rows);
    else void action(key);
  }
  function onMouse(key, data) {
    const bounds = box();
    if (stopped || bounds.narrow || !data) return;
    if (key === 'MOUSE_LEFT_BUTTON_PRESSED') {
      const hit = hitTest(bounds.controls, data.x, data.y);
      if (hit?.index !== undefined) select(hit.index);
      else if (hit?.key) void action(hit.key);
    } else if (key === 'MOUSE_WHEEL_UP' || key === 'MOUSE_WHEEL_DOWN') {
      const delta = key === 'MOUSE_WHEEL_UP' ? -1 : 1;
      const inside = rect => data.x > rect.x && data.x < rect.end && data.y > rect.y && data.y < rect.bottom;
      if (inside(bounds.panels.watchlist)) select(state.selected + delta);
      else if (inside(bounds.panels.center)) scroll(delta * 3);
    }
  }
  function close() {
    if (closing) return done;
    closing = true; stopped = true; state.ready = false;
    term.removeListener('key', onKey); term.removeListener('mouse', onMouse); term.removeListener('resize', draw);
    signals.removeListener('SIGINT', onSignal); signals.removeListener('SIGTERM', onSignal);
    input?.removeListener('end', onSignal); input?.removeListener('close', onSignal);
    backend?.removeListener?.('failure', onFailure);
    // Restore input/display immediately, then await our backend's EOF/reap lifecycle.
    for (const restore of [() => term.grabInput(false), () => term.hideCursor(false),
      () => term.styleReset(), () => term.fullscreen(false)]) {
      try { restore(); } catch (error) { state.error = safeError(error); }
    }
    void (async () => {
      try { await backend?.close(); } catch (error) { state.error = safeError(error); }
      finally { finish(); }
    })();
    return done;
  }
  const onSignal = () => { void close(); };
  term.fullscreen(true); term.grabInput({ mouse: 'button' }); term.hideCursor(true);
  term.on('key', onKey); term.on('mouse', onMouse); term.on('resize', draw);
  signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
  input?.on('end', onSignal); input?.on('close', onSignal);
  const ready = (async () => {
    try {
      backend ??= backendFactory({ root });
      backend.on?.('failure', onFailure); state.ready = true;
      await request('show');
    } catch (error) { state.ready = false; report(error); }
  })();
  draw();
  // Stable IDs + 1-based rectangles allow recording tools to click the actual terminal controls.
  return { state, ready, done, close, action, draw, keys: KEYS,
    get layout() { return box(); }, get controls() { return box().controls; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Interactive terminal required (at least 100 x 30).'); process.exitCode = 2;
  } else startMarketUI();
}