import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGuruService, validateGuruRequest } from '../../ui/guru-service.js';

// Deliberately synthetic contract fixtures, never used in the production service.
const cik = '0000000001';
const period = '2026-06-30';
const funds = { funds: [{ cik, name: 'TEST ONLY', active: 1, show_in_default: 1, returns: { '1y_total': 23.8 } }], note: 'TEST ONLY' };
const quarters = { quarters: [{ period, fund_count: 1, not_filed_count: 0 }], default_period: period, total_visible_funds: 1, cache_age_h: 120 };
const fund = { fund: { cik, name: 'TEST ONLY' }, period, periods_available: [period, '2026-03-31'], holdings: [{ cusip: 'TEST ONLY', name: 'TEST ONLY', ticker: null, shares: 2, value: 10, pct_portfolio: 7.5, pct_change: null }], returns: { '1y_total': 23.8 }, return_end_period: period, returns_current: false };
const popular = { period, manager_funds: [{ ticker: null, name: 'TEST ONLY', manager_count: 1, total_value: 10 }] };
const changes = { period, changes: [{ cik, name: 'TEST ONLY', change_type: 'NEW', value: 10, pct_change: null }], fund_status: [], filed_count: 1, not_filed_count: 0 };
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...options });
const code = expected => error => error.code === expected;

function setup(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.endsWith('/funds')) return json(funds);
    if (path.endsWith('/quarters')) return json(quarters);
    if (path.endsWith('/holdings')) return json({ ...fund, period: parsed.searchParams.get('period') || period });
    if (path.endsWith('/recent-changes')) return json(changes);
    return json(popular);
  };
  return { calls, service: buildGuruService({ fetchImpl, ...options }) };
}

test('accepts only documented methods and bounded typed parameters', () => {
  assert.deepEqual(validateGuruRequest('guru.popular'), { refresh: false, include_index: false, limit: 30, mode: 'popular' });
  assert.equal(validateGuruRequest('guru.changes').limit, 200);
  for (const [method, params] of [
    ['toString', {}], ['guru.http', {}], ['guru.funds', null], ['guru.funds', []],
    ['guru.funds', { url: 'https://elsewhere.invalid' }], ['guru.funds', { token: 'secret' }],
    ['guru.funds', { refresh: 'true' }], ['guru.funds', { refresh: undefined }],
    ['guru.fund', {}], ['guru.fund', { id: '../funds' }], ['guru.fund', { id: 1 }],
    ['guru.fund', { id: cik, period: '2026-06-31' }], ['guru.fund', { id: cik, period: '2026-06-30&url=x' }],
    ['guru.popular', { mode: '../funds' }], ['guru.popular', { include_index: 1 }],
    ['guru.popular', { limit: 31 }], ['guru.popular', { limit: 0 }], ['guru.popular', { limit: 1.5 }],
    ['guru.changes', { limit: 201 }], ['guru.changes', { type: 'EXIT' }],
    ['guru.changes', { cik: '0000000001/holdings' }],
  ]) assert.throws(() => validateGuruRequest(method, params), code('GURU_INVALID_REQUEST'));
  assert.throws(() => validateGuruRequest('guru.funds', { get refresh() { throw new Error('getter executed'); } }), code('GURU_INVALID_REQUEST'));
  assert.throws(() => validateGuruRequest('guru.funds', { [Symbol('url')]: 'x' }), code('GURU_INVALID_REQUEST'));
});

test('uses fixed GET origin with no credentials, redirects or extra headers', async () => {
  const { service, calls } = setup();
  const result = await service.request('guru.funds');
  assert.deepEqual(result.data, funds);
  assert.equal(result.source.url, 'https://easyinvesting.app/api/guru/funds');
  assert.equal(result.source.independentlyVerified, false);
  assert.equal(result.source.cacheTtlSeconds, 300);
  assert.equal(result.source.cached, false);
  assert.match(result.limitations.join(' '), /redistribution license/);
  assert.match(result.limitations.join(' '), /not actual fund returns/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json' });
});

test('fund detail checks the funds universe and preserves historical return coverage, nulls and percent units', async () => {
  const { service, calls } = setup();
  const result = await service.request('guru.fund', { id: cik, period: '2026-03-31' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `https://easyinvesting.app/api/guru/fund/${cik}/holdings?period=2026-03-31`);
  assert.equal(result.data.period, '2026-03-31');
  assert.equal(result.data.return_end_period, period);
  assert.equal(result.data.returns['1y_total'], 23.8);
  assert.equal(result.data.holdings[0].pct_portfolio, 7.5);
  assert.equal(result.data.holdings[0].ticker, null);
  assert.equal(result.data.holdings[0].pct_change, null);
  assert.equal(result.data.returns_current, false);
  await assert.rejects(service.request('guru.fund', { id: '0000000002' }), code('GURU_INVALID_REQUEST'));
  assert.equal(calls.length, 2);
});

test('quarters default and popularity variants map exactly to observed endpoints', async () => {
  const { service, calls } = setup();
  const q = await service.request('guru.quarters');
  assert.equal(q.source.upstreamCacheAgeHours, 120);
  for (const mode of ['popular', 'buys', 'sells']) {
    const result = await service.request('guru.popular', { mode });
    assert.equal(result.source.url, `https://easyinvesting.app/api/guru/${mode}?period=${period}&include_index=false&limit=30`);
  }
  assert.equal(calls.length, 4);
  const result = await service.request('guru.popular', { period, include_index: true, limit: 10 });
  assert.match(result.source.url, /include_index=true&limit=10$/);
});

test('recent changes supports actual type and fund filters with universe validation', async () => {
  const { service, calls } = setup();
  const result = await service.request('guru.changes', { period, cik, type: 'SOLD', limit: 20 });
  assert.equal(result.source.url, `https://easyinvesting.app/api/guru/recent-changes?period=${period}&include_index=false&limit=20&type=SOLD&cik=${cik}`);
  assert.equal(calls.length, 2);
  await assert.rejects(service.request('guru.changes', { cik: '0000000002' }), code('GURU_INVALID_REQUEST'));
  assert.equal(calls.length, 2);
});

test('cache expires at five minutes, refresh bypasses it, and callers cannot mutate cached data', async () => {
  let time = Date.parse('2026-09-11T00:00:00Z');
  const { service, calls } = setup({ now: () => time });
  const first = await service.request('guru.funds');
  first.data.funds[0].cik = 'changed';
  first.limitations.length = 0;
  time += 299999;
  const cached = await service.request('guru.funds');
  assert.equal(cached.source.cached, true);
  assert.equal(cached.data.funds[0].cik, cik);
  assert.equal(cached.source.fetchedAt, '2026-09-11T00:00:00.000Z');
  assert.ok(cached.limitations.length > 0);
  assert.equal(calls.length, 1);
  time += 1;
  assert.equal((await service.request('guru.funds')).source.cached, false);
  assert.equal(calls.length, 2);
  await service.request('guru.funds', { refresh: true });
  assert.equal(calls.length, 3);
});

test('same-endpoint requests including refresh share one in-flight GET', async () => {
  let release;
  let count = 0;
  const service = buildGuruService({ fetchImpl: () => { count++; return new Promise(resolve => { release = resolve; }); } });
  const first = service.request('guru.funds');
  const second = service.request('guru.funds', { refresh: true });
  assert.equal(count, 1);
  release(json(funds));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.notEqual(results[0].data, results[1].data);
});

test('cache entries and bytes are bounded', async () => {
  const { service, calls } = setup({ maxCacheEntries: 1 });
  await service.request('guru.funds');
  await service.request('guru.quarters');
  await service.request('guru.funds');
  assert.equal(calls.length, 3);
  const small = setup({ maxCacheBytes: 1 });
  await small.service.request('guru.funds');
  await small.service.request('guru.funds');
  assert.equal(small.calls.length, 2);
});

test('rejects status, redirect, content type, invalid JSON and wrong schemas without fallback or retry', async () => {
  const cases = [
    [() => json({}, { status: 401 }), 'GURU_HTTP_ERROR'],
    [() => json({}, { status: 503 }), 'GURU_HTTP_ERROR'],
    [() => new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }), 'GURU_HTTP_ERROR'],
    [() => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }), 'GURU_INVALID_RESPONSE'],
    [() => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), 'GURU_INVALID_RESPONSE'],
    [() => json({ funds: 'not an array' }), 'GURU_INVALID_RESPONSE'],
    [() => json({ funds: [{ cik: '../outside', name: 'TEST' }] }), 'GURU_INVALID_RESPONSE'],
    [() => json({ funds: [funds.funds[0], funds.funds[0]] }), 'GURU_INVALID_RESPONSE'],
    [() => json({ funds: [], error: 'upstream secret' }), 'GURU_INVALID_RESPONSE'],
    [() => new Response('{"funds":[],"x":1e400}', { headers: { 'Content-Type': 'application/json' } }), 'GURU_INVALID_RESPONSE'],
    [() => { const r = json(funds); Object.defineProperty(r, 'redirected', { value: true }); return r; }, 'GURU_REDIRECT'],
    [() => { const r = json(funds); Object.defineProperty(r, 'url', { value: 'https://other.invalid' }); return r; }, 'GURU_REDIRECT'],
    [() => { throw new Error('secret upstream credentials'); }, 'GURU_UNAVAILABLE'],
  ];
  for (const [make, expected] of cases) {
    let count = 0;
    const service = buildGuruService({ fetchImpl: async () => { count++; return make(); } });
    await assert.rejects(service.request('guru.funds'), error => error.code === expected && !error.message.includes('secret'));
    assert.equal(count, 1);
  }
});

test('concurrent failures are sanitized for every caller', async () => {
  let reject;
  const service = buildGuruService({ fetchImpl: () => new Promise((_, fail) => { reject = fail; }) });
  const a = service.request('guru.funds');
  const b = service.request('guru.funds');
  reject(new Error('secret details'));
  for (const result of await Promise.allSettled([a, b])) {
    assert.equal(result.reason.code, 'GURU_UNAVAILABLE');
    assert.doesNotMatch(result.reason.message, /secret/);
  }
});

test('rejects declared and streamed oversize payloads and invalid UTF-8', async () => {
  for (const make of [
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '101' } }),
    () => new Response('x'.repeat(101), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const service = buildGuruService({ fetchImpl: async () => make(), maxResponseBytes: 100 });
    await assert.rejects(service.request('guru.funds'), code('GURU_RESPONSE_TOO_LARGE'));
  }
  const service = buildGuruService({ fetchImpl: async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(service.request('guru.funds'), code('GURU_INVALID_RESPONSE'));
});

test('timeout bounds both pending headers and stalled body reads', async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const service = buildGuruService({ fetchImpl, timeoutMs: 15 });
    await assert.rejects(service.request('guru.funds'), code('GURU_TIMEOUT'));
  }
});

test('rate limits honor Retry-After and refresh cannot bypass the cooldown', async () => {
  let time = 0;
  let calls = 0;
  const service = buildGuruService({ now: () => time, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : json(funds);
  } });
  await assert.rejects(service.request('guru.funds'), code('GURU_RATE_LIMITED'));
  time = 119999;
  await assert.rejects(service.request('guru.funds', { refresh: true }), code('GURU_RATE_LIMITED'));
  assert.equal(calls, 1);
  time = 120000;
  await service.request('guru.funds');
  assert.equal(calls, 2);
});

test('failed refresh invalidates older success instead of returning stale holdings', async () => {
  let calls = 0;
  const service = buildGuruService({ fetchImpl: async () => ++calls === 1 ? json(funds) : json({}, { status: 503 }) });
  await service.request('guru.funds');
  await assert.rejects(service.request('guru.funds', { refresh: true }), code('GURU_HTTP_ERROR'));
  await assert.rejects(service.request('guru.funds'), code('GURU_HTTP_ERROR'));
  assert.equal(calls, 3);
});

test('mismatched fund/period and missing quarter are explicit failures', async () => {
  const wrong = setup({ fetchImpl: async url => url.endsWith('/funds') ? json(funds) : json({ ...fund, fund: { cik: '0000000002', name: 'TEST ONLY' } }) });
  await assert.rejects(wrong.service.request('guru.fund', { id: cik }), code('GURU_INVALID_RESPONSE'));
  const mismatch = setup({ fetchImpl: async () => json(popular) });
  await assert.rejects(mismatch.service.request('guru.popular', { period: '2026-03-31' }), code('GURU_INVALID_RESPONSE'));
  const empty = setup({ fetchImpl: async () => json({ quarters: [], default_period: null }) });
  await assert.rejects(empty.service.request('guru.changes'), code('GURU_NO_PERIOD'));
});

test('busy bound allows duplicate joins but refuses additional distinct GETs', async () => {
  let release;
  const service = buildGuruService({ maxInFlight: 1, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = service.request('guru.funds');
  await assert.rejects(service.request('guru.quarters'), code('GURU_BUSY'));
  release(json(funds));
  await pending;
});

test('safety settings cannot disable bounds', () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxResponseBytes: Infinity }, { cacheTtlMs: 300001 }, { maxCacheEntries: 65 }, { maxInFlight: 9 }]) {
    assert.throws(() => buildGuruService(options), TypeError);
  }
});

// Opt-in only: node tests/ui/guru-service.test.js --live. No holdings are persisted.
test('live reference GET smoke (explicit --live only)', { skip: !process.argv.includes('--live') }, async t => {
  const service = buildGuruService();
  const list = await service.request('guru.funds');
  assert.ok(list.data.funds.length > 0);
  const id = list.data.funds[0].cik;
  const results = [['guru.funds', list]];
  for (const [method, params] of [['guru.fund', { id }], ['guru.popular', {}], ['guru.changes', {}]]) {
    results.push([method, await service.request(method, params)]);
  }
  for (const [method, result] of results) {
    assert.equal(result.source.provider, 'easyinvesting.app');
    t.diagnostic(JSON.stringify({ method, source: result.source, keys: Object.keys(result.data), period: result.data.period,
      count: result.data.funds?.length ?? result.data.holdings?.length ?? result.data.manager_funds?.length ?? result.data.changes?.length }));
  }
});