// Transport/unit fixtures only: no model, network market lookup or archive writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { guiRequest, startGUI } from '../../ui/gui-server.js';
import { chromium, expect } from './helpers/dependencies.js';
import { guruVerificationFixture } from './helpers/guru-fixture.js';

const root = path.resolve('isolated-future-scope-root');
const windowSpec = { archive_id: '77777777-7777-4777-8777-777777777777', start: '2026-01-02', end: '2026-06-30' };
const customRule = () => ({ all: [
  { left: { indicator: 'sma', period: 21, lag: 1 }, op: 'crosses_above', right: { indicator: 'ema', period: 63 } },
  { any: [
    { left: { operation: 'divide', left: { field: 'close' }, right: { field: 'close', lag: 5 } }, op: 'gte', right: 1.02 },
    { not: { left: { indicator: 'rsi', period: 7 }, op: 'lte', right: 30 } },
  ] },
] });
const criteria = () => ({ ...windowSpec, symbol: 'AAPL', initial_cash: '10000', fee_bps: '10', slippage_bps: '5',
  entry: customRule(), exit: { left: { indicator: 'return', period: 5 }, op: 'lt', right: -0.05 } });
const portfolio = () => {
  const { symbol, ...shared } = criteria();
  return { ...shared, weights: { AAPL: '.4', 'BRK-B': '.3', 'BRK.B': '.2' }, rebalance_every: 2,
    allocation: { mode: 'momentum', lookback: 63, top_n: 2, minimum_return: '0.0250' }, rebalance_calendar: 'quarterly' };
};
const correlation = () => ({ ...windowSpec, symbols: ['AAPL', 'BRK-B'], frequency: 'monthly' });
const trigger = () => ({ ...windowSpec, symbol: 'AAPL', target_symbol: 'BRK-B', condition: customRule(), horizons: [1, 5, 60] });
const guru = (count = 1) => ({ as_of: '2026-09-11', filings: [{ manager: 'Synthetic transport fixture', period: '2026-06-30',
  filed_at: '2026-08-14', source_url: 'https://www.sec.gov/Archives/fixture-only',
  holdings: Array.from({ length: count }, (_, index) => ({ cusip: String(index).padStart(9, '0'),
    name: `Fixture holding ${index}`, value_usd: '1000', shares: '10' })),
}] });
const point = (phase = 'strategy') => ({ phase, completed: 1, total: 2, date: windowSpec.start,
  nav: '10000', cagr: null, max_drawdown: '0' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const headers = app => ({ 'Content-Type': 'application/json', Origin: app.origin, 'X-ITT-Token': app.token });
const post = (app, method, params, route = '/api', overrides = {}) => fetch(app.origin + route, {
  method: 'POST', headers: { ...headers(app), ...overrides }, body: JSON.stringify({ method, params }),
});

// Reads one NDJSON record at a time without assuming network chunk boundaries.
function records(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', ended = false;
  return async () => {
    while (!buffer.includes('\n') && !ended) {
      const { value, done } = await reader.read();
      ended = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) { assert.equal(buffer, '', 'terminal record must end with newline'); return null; }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    return JSON.parse(line);
  };
}

test('expanded symbols, nested custom rules, numeric RHS and portfolio options remain exact', () => {
  for (const symbols of [['AAPL'], ['BRK.B', 'BRK-B', 'A123456789'], ['SPY', 'QQQ', 'IWM']]) {
    assert.deepEqual(guiRequest('market.fetch', { symbols }, root), {
      method: 'market.fetch', params: { symbols, store: path.join(root, '.itt/market') },
    });
  }
  for (const symbols of [[], ['AAPL', 'AAPL'], ['../AAPL'], ['aapl'], ['A1234567890'],
    Array.from({ length: 11 }, (_, i) => `A${i}`)]) assert.throws(() => guiRequest('market.fetch', { symbols }, root));
  for (const [method, spec] of [['market.backtest', criteria()], ['market.portfolio', portfolio()],
    ['market.correlation', correlation()], ['market.trigger', trigger()]]) {
    const original = structuredClone(spec);
    assert.deepEqual(guiRequest(method, { spec }, root), { method, params: { spec, store_path: path.join(root, '.itt/market') } });
    assert.deepEqual(spec, original, 'no injected defaults, coercion, asset substitution or flattening');
  }
  const spec = guru();
  assert.deepEqual(guiRequest('market.guru', { spec }, root), { method: 'market.guru', params: { spec } });
});

test('analytics and legacy Python Guru transport reject unknown keys and client paths before backend dispatch', () => {
  for (const [method, spec] of [['market.correlation', correlation()], ['market.trigger', trigger()], ['market.guru', guru()]]) {
    for (const key of ['store', 'store_path', 'path', 'spec_path', 'unknown']) {
      assert.throws(() => guiRequest(method, { spec, [key]: '../private' }, root));
      assert.throws(() => guiRequest(method, { spec: { ...spec, [key]: '../private' } }, root));
    }
    for (const bad of [null, [], '../private.json', { ...spec, as_of: '2026-02-30' }]) {
      assert.throws(() => guiRequest(method, { spec: bad }, root));
    }
  }
  for (const change of [{ symbols: ['AAPL'] }, { symbols: ['AAPL', '../QQQ'] },
    { symbols: ['AAPL', 'AAPL'] }, { frequency: 'hourly' }]) {
    assert.throws(() => guiRequest('market.correlation', { spec: { ...correlation(), ...change } }, root));
  }
  for (const change of [{ symbol: '../AAPL' }, { target_symbol: '../QQQ' },
    { condition: { left: 'close', op: 'gt', right: true } }, { horizons: [1, 1] }, { horizons: [] },
    { horizons: [0] }, { horizons: [61] }, { horizons: [true] }]) {
    assert.throws(() => guiRequest('market.trigger', { spec: { ...trigger(), ...change } }, root));
  }
  for (const change of [{ allocation: { mode: 'eval' } }, { allocation: { top_n: 4 } },
    { allocation: { lookback: true } }, { allocation: { lookback: 253 } },
    { allocation: { minimum_return: true } }, { allocation: { path: '../private' } },
    { rebalance_calendar: 'yearly' }]) {
    assert.throws(() => guiRequest('market.portfolio', { spec: { ...portfolio(), ...change } }, root));
  }
});

test('ordinary HTTP dispatch accepts each new method and preserves exact reviewed spec', async t => {
  const calls = [];
  const app = await startGUI({ root, backend: { request: async (...args) => { calls.push(args); return { reviewed: args[1].spec }; }, close: async () => {} } });
  t.after(() => app.close());
  for (const [method, spec] of [['market.backtest', criteria()], ['market.portfolio', portfolio()],
    ['market.correlation', correlation()], ['market.trigger', trigger()], ['market.guru', guru()]]) {
    for (const params of [{ spec, store_path: '../private' }, { spec: { ...spec, path: '../private' } }]) {
      const count = calls.length;
      assert.equal((await post(app, method, params)).status, 400);
      assert.equal(calls.length, count);
    }
    const response = await post(app, method, { spec });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { reviewed: spec } });
    assert.deepEqual(calls.at(-1), [method, method === 'market.guru' ? { spec } : { spec, store_path: path.join(root, '.itt/market') }]);
  }
});

test('/api/stream shares Host, Origin, token and content-type guards and method allowlist', { timeout: 10000 }, async t => {
  const calls = [];
  const app = await startGUI({ backend: { request: async (...args) => { calls.push(args); return {}; }, close: async () => {} } });
  t.after(() => app.close());
  for (const overrides of [{ Origin: 'https://evil.example' }, { Origin: '' },
    { 'X-ITT-Token': 'wrong' }, { 'X-ITT-Token': '' }, { 'Content-Type': 'text/plain' }, { 'Content-Type': '' }]) {
    const response = await post(app, 'market.backtest', { spec: criteria() }, '/api/stream', overrides);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false });
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.request(app.origin + '/api/stream', { method: 'POST', headers: { ...headers(app), Host: 'evil.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ method: 'market.backtest', params: { spec: criteria() } }));
  });
  assert.equal(hostStatus, 403);
  for (const method of ['capabilities', 'copilot.status', 'market.guru', 'market.correlation', 'market.trigger', 'market.backtest.stream']) {
    assert.equal((await post(app, method, {}, '/api/stream')).status, 400);
  }
  assert.equal((await post(app, 'market.backtest', { spec: criteria(), store_path: '../private' }, '/api/stream')).status, 400);
  assert.equal((await fetch(app.origin + '/api/stream')).status, 404);
  assert.deepEqual(calls, []);
});

test('/api/stream rejects lookalike JSON media types', async t => {
  const calls = [];
  const app = await startGUI({ backend: { request: async (...args) => { calls.push(args); return {}; }, close: async () => {} } });
  t.after(() => app.close());
  const response = await post(app, 'market.backtest', { spec: criteria() }, '/api/stream', { 'Content-Type': 'application/jsonp' });
  await response.text();
  assert.equal(response.status, 403, 'application/jsonp is not application/json');
  assert.deepEqual(calls, []);
});

for (const [method, build] of [['market.backtest', criteria], ['market.portfolio', portfolio]]) {
  test(`${method} HTTP emits intermediate callbacks before controlled result, then one terminal record`, { timeout: 10000 }, async t => {
    const gate = deferred(), calls = [], spec = build();
    let completed = false;
    const app = await startGUI({ root, backend: { request: (name, params, options) => {
      calls.push([name, params]);
      options.onProgress(point());
      return gate.promise.then(result => { completed = true; return result; });
    }, close: async () => { gate.resolve({ closed: true }); } } });
    t.after(() => app.close());
    const response = await post(app, method, { spec }, '/api/stream', { 'Content-Type': 'application/json; charset=utf-8' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/x-ndjson;/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const next = records(response);
    assert.deepEqual(await next(), { event: 'progress', data: point() });
    assert.equal(completed, false, 'progress must be observable while the backend result is still pending');
    assert.deepEqual(calls, [[method + '.stream', { store_path: path.join(root, '.itt/market'), spec }]]);
    const result = { spec, strategy: { metrics: { final_nav: '12345.67' } } };
    gate.resolve(result);
    assert.deepEqual(await next(), { event: 'result', result });
    assert.equal(await next(), null, 'exactly one terminal ending, followed by EOF');
    assert.equal(completed, true);
  });
}

test('HTTP progress followed by rejection ends with safe error and no result or retry', { timeout: 10000 }, async t => {
  const gate = deferred();
  let calls = 0;
  const app = await startGUI({ backend: { request: (_method, _params, { onProgress }) => {
    calls++; onProgress(point()); return gate.promise;
  }, close: async () => { gate.resolve({}); } } });
  t.after(() => app.close());
  const next = records(await post(app, 'market.backtest', { spec: criteria() }, '/api/stream'));
  assert.deepEqual(await next(), { event: 'progress', data: point() });
  gate.reject(Object.assign(new Error('SECRET_ARCHIVE_PATH'), { code: 'input_rejected' }));
  assert.deepEqual(await next(), { event: 'error', error: { code: 'input_rejected', message: 'Input was rejected.' } });
  assert.equal(await next(), null);
  assert.equal(calls, 1);
});

test('HTTP stream never exposes unknown raw error codes or messages', async t => {
  const app = await startGUI({ backend: { request: async () => {
    throw Object.assign(new Error('SECRET_PATH'), { code: 'SECRET_CODE' });
  }, close: async () => {} } });
  t.after(() => app.close());
  const response = await post(app, 'market.backtest', { spec: criteria() }, '/api/stream');
  const text = await response.text();
  assert.doesNotMatch(text, /SECRET/);
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'error');
  assert.equal(rows[0].error.code, 'internal_error');
});

test('close destroys an active HTTP stream even if the backend request never settles', { timeout: 5000 }, async () => {
  let closed = false;
  const app = await startGUI({ backend: { request: (_method, _params, { onProgress }) => {
    onProgress(point()); return new Promise(() => {});
  }, close: async () => { closed = true; } } });
  try {
    const next = records(await post(app, 'market.portfolio', { spec: portfolio() }, '/api/stream'));
    assert.equal((await next()).event, 'progress');
    const ending = next().then(value => ({ value }), error => ({ error }));
    await app.close();
    assert.equal(closed, true);
    const outcome = await ending;
    assert.ok(outcome.error || outcome.value === null, 'socket must close, not synthesize success');
  } finally { await app.close(); }
});

test('legacy Python Guru transport permits bodies over 16KiB up to 2MiB while ordinary and stream bodies remain 16KiB', { timeout: 15000 }, async t => {
  const calls = [];
  const app = await startGUI({ backend: { request: async (...args) => { calls.push(args); return { accepted: true }; }, close: async () => {} } });
  t.after(() => app.close());
  const spec = guru(300), payload = JSON.stringify({ method: 'market.guru', params: { spec } });
  assert.ok(Buffer.byteLength(payload) > 16384);
  const accepted = await post(app, 'market.guru', { spec });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, result: { accepted: true } });
  assert.deepEqual(calls, [['market.guru', { spec }]]);
  // Whitespace keeps the JSON/spec valid, so this probes the byte limit rather than schema validation.
  const padded = (method, spec, bytes) => {
    const body = JSON.stringify({ method, params: { spec } });
    return body + ' '.repeat(bytes - Buffer.byteLength(body));
  };
  for (const route of ['/api', '/api/stream']) {
    const rejected = await fetch(app.origin + route, { method: 'POST', headers: headers(app),
      body: padded('market.backtest', criteria(), 16385) });
    assert.equal(rejected.status, 413);
    await rejected.text();
  }
  const max = await fetch(app.origin + '/api', { method: 'POST', headers: headers(app),
    body: padded('market.guru', guru(), 2 * 1024 * 1024) });
  assert.equal(max.status, 200);
  await max.text();
  const over = await fetch(app.origin + '/api', { method: 'POST', headers: headers(app),
    body: padded('market.guru', guru(), 2 * 1024 * 1024 + 1) });
  assert.equal(over.status, 413);
  await over.text();
  assert.equal(calls.length, 2, 'only the two bounded Guru requests reach the backend');
});

test('automatic Guru verifier fixture passes production response validation for every endpoint without network', async () => {
  const fixture = guruVerificationFixture();
  for (const [method, params, key] of [
    ['guru.funds', {}, 'funds'], ['guru.quarters', {}, 'quarters'],
    ['guru.fund', { id: fixture.cik }, 'fund'],
    ['guru.popular', { period: fixture.period }, 'popular'],
    ['guru.changes', { period: fixture.period }, 'changes'],
  ]) {
    const response = await fixture.service.request(method, params);
    assert.deepEqual(response.data, fixture.payloads[key]);
    assert.equal(response.source.independentlyVerified, false);
  }
  const historical = await fixture.service.request('guru.fund', { id: fixture.cik, period: fixture.historical });
  assert.deepEqual(historical.data, { ...fixture.payloads.fund, period: fixture.historical });
  assert.equal(historical.data.return_end_period, fixture.period);
  assert.equal(historical.data.returns['3y_annualized'], null);
  assert.ok(fixture.requests.length >= 6);
});

test('automatic Guru in the real app crosses HTTP and injected production adapter, not manual market.guru', { timeout: 30000 }, async () => {
  const fixture = guruVerificationFixture(), backendCalls = [], errors = [], calls = [];
  const app = await startGUI({ guru: fixture.service, backend: {
    async request(method) {
      backendCalls.push(method);
      throw Object.assign(new Error('No market archive in automatic Guru fixture test'), { code: 'io_error' });
    }, async close() {},
  } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      assert.equal(new URL(route.request().url()).origin, app.origin, 'Browser must not call an external feed');
      return route.continue();
    });
    page.on('request', request => {
      if (request.method() === 'POST') calls.push(request.postDataJSON());
    });
    await page.goto(app.url);
    assert.deepEqual(errors, [], 'Actual app must initialize without a test-only DOM repair');
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'error');
    assert.deepEqual(fixture.requests, [], 'No Guru calls before opening its view');
    await page.locator('#nav-research').click();
    await page.locator('#research-tab-guru').click();
    await expect(page.locator('#guru-status')).toHaveText('Loaded.');
    assert.deepEqual(calls.filter(call => call.method.startsWith('guru.')), [
      { method: 'guru.funds', params: {} }, { method: 'guru.quarters', params: {} },
    ]);
    await expect(page.locator('#guru-funds-table')).toContainText(fixture.label);
    await expect(page.locator('#guru-funds-table')).toContainText('23.8%');
    await expect(page.locator('#guru-funds-table')).not.toContainText('2,380%');
    assert.equal(await page.locator('#guru-file, #guru-json, #guru-run').count(), 0);
    const response = page.waitForResponse(response => response.request().postDataJSON()?.method === 'guru.fund');
    await page.locator(`[data-fund-id="${fixture.cik}"]`).click();
    const envelope = await (await response).json();
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result.data, fixture.payloads.fund);
    assert.equal(envelope.result.source.independentlyVerified, false);
    await expect(page.locator('#guru-holdings-table')).toContainText(fixture.label);
    await page.locator('#guru-detail-quarter').selectOption(fixture.historical);
    await expect(page.locator('#guru-holdings-table caption')).toContainText(fixture.historical);
    await expect(page.locator('#guru-performance')).toContainText(`Return coverage: 2020-12-31 → ${fixture.period}`);
    await expect(page.locator('#guru-performance')).toContainText('Returns current: false');
    for (const [tab, key] of [['popular', 'popular'], ['changes', 'changes']]) {
      const pending = page.waitForResponse(response => response.request().postDataJSON()?.method === `guru.${key}`);
      await page.locator(`#guru-tab-${tab}`).click();
      const body = await (await pending).json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.result.data, fixture.payloads[key]);
      await expect(page.locator(`#guru-${tab}-table`)).toBeVisible();
    }
    assert.deepEqual(backendCalls, ['market.show'], 'Automatic Guru never dispatches to the Python manual filing command');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await app.close(); }
});