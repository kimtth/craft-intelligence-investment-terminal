import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { guiRequest, startGUI } from '../../ui/gui-server.js';

const criteriaSpec = () => ({
  archive_id: '77777777-7777-4777-8777-777777777777', symbol: 'SPY',
  start: '2026-01-02', end: '2026-06-30', initial_cash: '10000', fee_bps: '10', slippage_bps: '5',
  entry: { left: 'sma20', op: 'gt', right: 'sma50' },
  exit: { left: 'sma20', op: 'lt', right: 'sma50' },
});

const portfolioSpec = () => {
  const { symbol, ...shared } = criteriaSpec();
  return { ...shared, weights: { SPY: '0.5', QQQ: '0.3', IWM: '0.2' }, rebalance_every: 5 };
};

test('dated download HTTP validates both bounds, preserves legacy callers and forwards exact inclusive dates', async t => {
  const calls = [];
  const app = await startGUI({ backend: { async close() {}, async request(method, params) {
    calls.push({ method, params }); return { requested: params };
  } } });
  t.after(() => app.close());
  const headers = { 'Content-Type': 'application/json', Origin: app.origin, 'X-ITT-Token': app.token };
  const post = params => fetch(app.origin + '/api', { method: 'POST', headers,
    body: JSON.stringify({ method: 'market.fetch', params }) });
  for (const params of [
    { start: '2024-01-01' }, { end: '2024-01-04' }, { start: '2024-01-05', end: '2024-01-04' },
    { start: '2023-02-29', end: '2024-01-04' }, { start: '2024-1-01', end: '2024-01-04' },
    { start: '0000-01-01', end: '2024-01-04' }, { start: '2024-01-01', end: '9999-12-31' },
    { start: null, end: null }, { start: true, end: '2024-01-04' }, { start: 'max', end: 'all' },
    { range: 'max' }, { store: 'elsewhere' },
  ]) assert.equal((await post({ symbols: ['MSFT', 'SPY'], ...params })).status, 400, JSON.stringify(params));
  assert.deepEqual(calls, []);
  for (const dates of [{}, { start: '2024-02-29', end: '2024-02-29' }, { start: '2021-01-01', end: '2026-09-11' }]) {
    const response = await post({ symbols: ['MSFT', 'SPY'], ...dates });
    assert.equal(response.status, 200);
    const forwarded = calls.at(-1).params;
    assert.deepEqual({ ...forwarded, store: undefined }, { symbols: ['MSFT', 'SPY'], ...dates, store: undefined });
    assert.deepEqual((await response.json()).result.requested, forwarded);
  }
});

test('market.portfolio forwards exact reviewed weights and cadence with repo-owned store_path', () => {
  const root = path.resolve('isolated-portfolio-root'), spec = portfolioSpec();
  assert.deepEqual(guiRequest('market.portfolio', { spec }, root), {
    method: 'market.portfolio', params: { store_path: path.join(root, '.itt/market'), spec },
  });
  assert.deepEqual(spec, portfolioSpec(), 'no mutation, normalization, asset substitution or extra defaults');
  for (const weights of [{ SPY: '1' }, { SPY: '0', QQQ: '0.1250', IWM: '2.5e-1' },
    { SPY: '.1', QQQ: '.2', IWM: '.7' }, { SPY: '1e-100' }, { SPY: '+.5', QQQ: '5e-1' }]) {
    const reviewed = { ...spec, weights, rebalance_every: 100000 };
    assert.deepEqual(guiRequest('market.portfolio', { spec: reviewed }, root).params.spec, reviewed);
  }
});

test('market.portfolio refuses paths, unknown fields, malformed weights and out-of-bound cadence', () => {
  const spec = portfolioSpec(), missing = { ...spec };
  delete missing.rebalance_every;
  for (const params of [undefined, {}, null, [], { spec: null }, { spec: [] }, { spec: 'portfolio.json' },
    { spec, store: 'elsewhere' }, { spec, store_path: 'elsewhere' }, { spec, spec_path: 'elsewhere' },
    { spec: { ...spec, symbol: 'SPY' } }, { spec: { ...spec, allocation: 'equal' } },
    { spec: { ...spec, store_path: 'elsewhere' } }, { spec: missing },
    ...[null, [], {}, 'weights.json', { '../AAPL': '1' }, { SPY: 1 }, { SPY: { value: '1' } },
      { SPY: '1', store_path: 'secret' }, { SPY: '0' }, { SPY: '-.1', QQQ: '.5' }, { SPY: '1.1' },
      { SPY: '.5', QQQ: '.5', IWM: '.00000000000000000001' },
      { SPY: '1.00000000000000000001' }, { SPY: 'NaN' }, { SPY: 'Infinity' },
      { SPY: '1e-101' }, { SPY: '1e999999999' }, { SPY: '0.' + '1'.repeat(63) }]
      .map(weights => ({ spec: { ...spec, weights } })),
    ...[undefined, null, '5', true, 0, -1, 1.5, 100001, Number.MAX_SAFE_INTEGER + 1, Infinity]
      .map(rebalance_every => ({ spec: { ...spec, rebalance_every } }))]) {
    assert.throws(() => guiRequest('market.portfolio', params), JSON.stringify(params));
  }
  assert.throws(() => guiRequest('market.backtest', { spec }), 'portfolio spec cannot enter single API');
  assert.throws(() => guiRequest('market.portfolio', { spec: criteriaSpec() }), 'single spec cannot enter portfolio API');
});

test('both real-market methods enforce bounded decimals, real dates and declarative criterion allowlists', () => {
  for (const [method, spec] of [['market.backtest', criteriaSpec()], ['market.portfolio', portfolioSpec()]]) {
    for (const change of [
      { archive_id: '' }, { archive_id: 'x'.repeat(129) }, { archive_id: 1 },
      { start: '2026-02-30' }, { start: '0000-01-01' }, { end: '2026-6-30' }, { end: spec.start }, { end: '2025-01-01' },
      { initial_cash: '0' }, { initial_cash: 10000 }, { initial_cash: '1e101' },
      { initial_cash: '1'.repeat(65) }, { fee_bps: '-1' }, { fee_bps: '10000' },
      { slippage_bps: '10000' }, { slippage_bps: 'NaN' },
      { entry: { left: 'arbitrary', op: 'gt', right: '0' } },
      { entry: { left: 'close', op: 'eval', right: '0' } },
      { entry: { left: 'close', op: 'gt', right: 'process.exit()' } },
      { exit: { ...spec.exit, right: '1e9999999' } }, { exit: { ...spec.exit, right: true } },
      { entry: { ...spec.entry, code: 'exec()' } },
    ]) assert.throws(() => guiRequest(method, { spec: { ...spec, ...change } }), `${method}: ${JSON.stringify(change)}`);
    const reviewed = { ...spec, initial_cash: '1e100', fee_bps: '9999.99999999999999999999',
      entry: { left: 'macd_signal9', op: 'crosses_above', right: '-1e-100' } };
    assert.deepEqual(guiRequest(method, { spec: reviewed }).params.spec, reviewed);
  }
});

test('portfolio HTTP guards, exact forwarding, response passthrough and safe backend rejection', async () => {
  const calls = [], spec = portfolioSpec();
  // Boundary fixture only. Engine correctness is tested by the Python portfolio tests.
  const result = { archive_id: spec.archive_id, spec, symbols: ['IWM', 'QQQ', 'SPY'],
    contract: { version: 'portfolio-v1' }, signals: { SPY: [], QQQ: [], IWM: [] },
    strategy: { metrics: { final_nav: '9999.75' }, daily: [{ date: spec.start, positions: { SPY: 0, QQQ: 0, IWM: 0 } }],
      fills: [{ symbol: 'QQQ', decision_id: 1 }], decisions: [{ decision_id: 1, targets: { SPY: 10, QQQ: 5, IWM: 2 } }],
      orders: [{ symbol: 'SPY', status: 'expired', reason: 'insufficient_cash_including_fees' }] },
    benchmark: { metrics: { final_nav: '10000.25' }, daily: [], fills: [] } };
  const app = await startGUI({ backend: { request: async (...args) => {
    calls.push(args);
    if (args[1].spec.archive_id !== spec.archive_id) throw Object.assign(new Error('private archive path'), { code: 'invalid_params' });
    return result;
  }, close: async () => {} } });
  try {
    const headers = { 'Content-Type': 'application/json', Origin: app.origin, 'X-ITT-Token': app.token };
    const post = (params, overrides = {}) => fetch(app.origin + '/api', { method: 'POST',
      headers: { ...headers, ...overrides }, body: JSON.stringify({ method: 'market.portfolio', params }) });
    assert.equal((await post({ spec }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ spec }, { 'X-ITT-Token': 'wrong' })).status, 403);
    assert.equal((await post({ spec }, { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await post({ spec, store_path: 'elsewhere' })).status, 400);
    assert.equal((await post({ spec: { ...spec, weights: { SPY: '1.00000000000000000001' } } })).status, 400);
    assert.equal((await post({ spec: { ...spec, rebalance_every: '5' } })).status, 400);
    assert.equal((await post({ spec: { ...spec, archive_id: 'x'.repeat(17000) } })).status, 413);
    assert.deepEqual(calls, [], 'invalid requests never reach backend');
    const response = await post({ spec });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, result, 'symbols, signals, positions and decisions remain intact');
    assert.equal(calls[0][0], 'market.portfolio');
    assert.deepEqual(Object.keys(calls[0][1]).sort(), ['spec', 'store_path']);
    assert.match(calls[0][1].store_path, /\.itt[\\/]market$/);
    assert.deepEqual(calls[0][1].spec, spec);
    const rejected = await post({ spec: { ...spec, archive_id: 'different-archive' } });
    assert.equal(rejected.status, 400);
    const text = await rejected.text();
    assert.equal(JSON.parse(text).error.code, 'invalid_params');
    assert.doesNotMatch(text, /private archive path/);
    assert.equal(calls.length, 2, 'no archive substitution, retry or secondary execution');
  } finally { await app.close(); }
});

test('market.backtest accepts only a declarative spec and injects repo-owned store_path', () => {
  const root = path.resolve('isolated-gui-root'), spec = criteriaSpec();
  assert.deepEqual(guiRequest('market.backtest', { spec }, root), {
    method: 'market.backtest', params: { store_path: path.join(root, '.itt/market'), spec },
  });
  assert.deepEqual(spec, criteriaSpec(), 'boundary does not mutate reviewed spec');
  for (const params of [undefined, {}, null, [], { spec: null }, { spec: [] }, { spec: 'criteria.json' },
    { spec, store: 'elsewhere' }, { spec, store_path: 'elsewhere' }, { spec, spec_path: 'elsewhere' },
    { spec: { ...spec, store_path: 'elsewhere' } }, { spec: { ...spec, source: 'file:///secret' } },
    { spec: { ...spec, initial_cash: 10000 } }, { spec: { ...spec, symbol: '../AAPL' } },
    { spec: { ...spec, entry: { ...spec.entry, code: 'process.exit()' } } },
    { spec: { ...spec, entry: { ...spec.entry, right: { path: 'secret' } } } },
    { spec: { ...spec, exit: { left: 'close', op: 'gt' } } }]) {
    assert.throws(() => guiRequest('market.backtest', params, root));
  }
});

test('backtest HTTP preserves exact spec and backend rejection, with origin/token guards', async () => {
  const calls = [], spec = criteriaSpec();
  const app = await startGUI({ backend: { request: async (...args) => {
    calls.push(args);
    if (args[1].spec.archive_id !== spec.archive_id) throw Object.assign(new Error('private path'), { code: 'invalid_params' });
    return { archive_id: spec.archive_id, spec: args[1].spec, signals: [], strategy: { daily: [] } };
  }, close: async () => {} } });
  try {
    const headers = { 'Content-Type': 'application/json', Origin: app.origin, 'X-ITT-Token': app.token };
    const post = (params, overrides = {}) => fetch(app.origin + '/api', { method: 'POST',
      headers: { ...headers, ...overrides }, body: JSON.stringify({ method: 'market.backtest', params }) });
    assert.equal((await post({ spec }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ spec }, { 'X-ITT-Token': 'wrong' })).status, 403);
    assert.equal((await post({ spec, store_path: 'elsewhere' })).status, 400);
    assert.equal((await post({ spec: { ...spec, entry: { ...spec.entry, store: 'elsewhere' } } })).status, 400);
    assert.deepEqual(calls, []);
    const response = await post({ spec });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result.spec, spec);
    assert.equal(calls[0][0], 'market.backtest');
    assert.deepEqual(Object.keys(calls[0][1]).sort(), ['spec', 'store_path']);
    assert.match(calls[0][1].store_path, /\.itt[\\/]market$/);
    assert.deepEqual(calls[0][1].spec, spec);
    const rejected = await post({ spec: { ...spec, archive_id: 'different-archive' } });
    assert.equal(rejected.status, 400);
    const failure = await rejected.text();
    assert.equal(JSON.parse(failure).ok, false);
    assert.doesNotMatch(failure, /private path/);
    assert.equal(calls.length, 2, 'no automatic archive substitution or retry');
  } finally { await app.close(); }
});

test('GUI allowlist injects local paths and refuses arbitrary commands and client paths', () => {
  assert.deepEqual(guiRequest('capabilities'), {method:'capabilities',params:{}});
  assert.match(guiRequest('market.show').params.store, /\.itt[\\/]market$/);
  for (const [method,params] of [['exec',{}],['research.start',{}],['market.show',{store:'x'}],
    ['market.fetch',{symbols:['../AAPL']}],['decisions.add',{id:'x',text:'hi'}]]) {
    assert.throws(()=>guiRequest(method,params));
  }
});
test('HTTP same origin/token security and shared backend round trip', async () => {
  const calls = [];
  const app = await startGUI({backend:{request:async(...args)=>{calls.push(args); return {kind:'real_market_snapshot'};},close:async()=>{}}});
  try {
    const response = await fetch(app.origin);
    assert.equal(response.status,200);
    assert.match(await response.text(), /Intelligent Trading Terminal/);
    const headers = {'Content-Type':'application/json','Origin':app.origin,'X-ITT-Token':app.token};
    const options = {method:'POST',headers,body:JSON.stringify({method:'market.show',params:{}})};
    assert.equal((await fetch(app.origin+'/api',{...options,headers:{...headers,Origin:'https://evil.example'}})).status,403);
    assert.equal((await fetch(app.origin+'/api',{...options,headers:{...headers,'X-ITT-Token':'wrong'}})).status,403);
    const result = await (await fetch(app.origin+'/api',options)).json();
    assert.equal(result.ok,true); assert.equal(calls[0][0],'market.show');
    assert.equal((await fetch(app.origin+'/api',{...options,body:JSON.stringify({method:'exec',params:{}})})).status,400);
    assert.equal((await fetch(app.origin+'/../pyproject.toml')).status,404);
  } finally { await app.close(); }
});

test('Copilot HTTP methods share origin/token guards, separate strict allowlist and cleanup order', async () => {
  const calls = [], closed = [];
  const app = await startGUI({
    backend: { request: async (...args) => { calls.push(['python', ...args]); return {}; }, close: async () => closed.push('backend') },
    copilot: { status: async () => { calls.push(['status']); return { provider: 'github_copilot', status: 'ready' }; },
      analyze: async params => { calls.push(['analyze', params]); return { answer: 'mock only' }; },
      criteria: async params => { calls.push(['criteria', params]); return {
        criteria: { entry: criteriaSpec().entry, exit: criteriaSpec().exit }, explanation: 'Mock proposal only',
      }; },
      close: async () => closed.push('copilot') },
  });
  try {
    const headers = { 'Content-Type': 'application/json', Origin: app.origin, 'X-ITT-Token': app.token };
    const post = (method, params, override = {}) => fetch(app.origin + '/api', {
      method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify({ method, params }),
    });
    const params = { symbol: 'QQQ', timestamp: 123, archiveId: '77777777-7777-4777-8777-777777777777',
      model: 'test-model', question: '한국어 日本語' };
    for (const method of ['copilot.status', 'copilot.analyze', 'copilot.criteria']) {
      assert.equal((await post(method, method.endsWith('status') ? {} : params, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post(method, method.endsWith('status') ? {} : params, { 'X-ITT-Token': 'wrong' })).status, 403);
    }
    assert.deepEqual(calls, []);
    for (const [method, value] of [['copilot.status', { token: 'SECRET' }], ['copilot.analyze', { ...params, store: 'bad' }],
      ['copilot.analyze', { ...params, consent: false }], ['copilot.analyze', { ...params, symbol: '../AAPL' }],
      ['copilot.criteria', { ...params, store_path: 'bad' }], ['copilot.criteria', { ...params, consent: false }],
      ['copilot.criteria', { ...params, timestamp: 0 }], ['copilot.criteria', { ...params, question: '' }],
      ['copilot.criteria', { ...params, model: '' }], ['copilot.criteria', { ...params, archiveId: 'bad' }],
      ['copilot.criteria', { ...params, code: 'arbitrary()' }],
      ['copilot.shell', {}]]) {
      assert.equal((await post(method, value)).status, 400);
    }
    assert.deepEqual(calls, []);
    assert.equal((await (await post('copilot.status', {})).json()).ok, true);
    assert.equal((await (await post('copilot.analyze', params)).json()).ok, true);
    assert.equal(calls[0][0], 'status');
    assert.deepEqual(calls[1], ['analyze', params]);
    const proposal = await (await post('copilot.criteria', params)).json();
    assert.equal(proposal.ok, true);
    assert.deepEqual(proposal.result.criteria, { entry: criteriaSpec().entry, exit: criteriaSpec().exit });
    assert.deepEqual(calls[2], ['criteria', params], 'same five request fields; no extra consent');
    assert.equal(calls.some(call => call[0] === 'python'), false, 'dispatch does not auto-run a backtest');
    assert.throws(() => guiRequest('copilot.status', {}));
    assert.throws(() => guiRequest('copilot.criteria', params));

    // Explicitly split inside a CJK UTF-8 sequence; decoding per chunk corrupts it.
    const payload = Buffer.from(JSON.stringify({ method: 'copilot.analyze', params }));
    const cut = payload.indexOf(Buffer.from('한국어')) + 1;
    const result = await new Promise((resolve, reject) => {
      const req = http.request(app.origin + '/api', { method: 'POST', headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', reject);
      req.write(payload.subarray(0, cut));
      setImmediate(() => req.end(payload.subarray(cut)));
    });
    assert.equal(result.ok, true);
    assert.equal(calls.at(-1)[1].question, params.question);
  } finally { await app.close(); }
  assert.deepEqual(closed, ['copilot', 'backend']);
});

test('Copilot HTTP never forwards raw SDK error code/message', async () => {
  const app = await startGUI({ backend: { close: async () => {} }, copilot: {
    status: async () => { throw Object.assign(new Error('SECRET_TOKEN'), { code: 'SECRET_CODE' }); }, close: async () => {},
  } });
  try {
    const response = await fetch(app.origin + '/api', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app.origin, 'X-ITT-Token': app.token },
      body: JSON.stringify({ method: 'copilot.status', params: {} }),
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.doesNotMatch(body, /SECRET/);
    assert.equal(JSON.parse(body).error.code, 'unavailable');
  } finally { await app.close(); }
});