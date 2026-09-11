// Authored tests only: optional real RPC subprocess coverage is not a Windows UI evaluation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectChild, createBackend, interpreterPath, ROOT, safeError } from '../../ui/backend.js';

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), writes: [], kills: [] });
  child.stdin.on('data', chunk => child.writes.push(JSON.parse(chunk.toString())));
  child.kill = signal => { child.kills.push(signal); child.emit('exit', null, signal); child.emit('close', null, signal); return true; };
  return child;
}
const closeFake = async (api, child) => { child.emit('exit', 0); child.emit('close', 0); await api.close(); };

const progressPoint = (phase = 'strategy', completed = 1) => ({
  phase, completed, total: 2, date: '2026-01-02', nav: '10000', cagr: null, max_drawdown: '0',
});

test('progress NDJSON is correlated, fragmented and nonterminal until each success arrives', async t => {
  const child = fakeChild(), api = connectChild(child), received = [[], []], settled = [false, false];
  t.after(() => closeFake(api, child));
  const pending = received.map((events, index) => api.request('market.backtest.stream', { spec: { symbol: index ? 'QQQ' : 'AAPL' } }, {
    onProgress: data => events.push(data),
  }).then(result => { settled[index] = true; return result; }));
  assert.deepEqual(child.writes.map(row => [row.id, row.method]), [
    ['ui-1', 'market.backtest.stream'], ['ui-2', 'market.backtest.stream'],
  ]);
  const first = progressPoint(), second = progressPoint('benchmark', 2);
  const line = JSON.stringify({ id: 'ui-2', event: 'progress', data: second }) + '\n';
  child.stdout.write(line.slice(0, 17));
  assert.deepEqual(received, [[], []]);
  child.stdout.write(line.slice(17) + JSON.stringify({ id: 'ui-1', event: 'progress', data: first }) + '\n');
  await Promise.resolve();
  assert.deepEqual(received, [[first], [second]]);
  assert.deepEqual(settled, [false, false], 'progress must not remove a pending request');
  child.stdout.write(JSON.stringify({ id: 'ui-2', ok: true, result: { symbol: 'QQQ' } }) + '\n');
  assert.deepEqual(await pending[1], { symbol: 'QQQ' });
  assert.equal(settled[0], false, 'another ID completing must not settle this request');
  child.stdout.write(JSON.stringify({ id: 'ui-1', event: 'progress', data: second }) + '\n'
    + JSON.stringify({ id: 'ui-1', ok: true, result: { symbol: 'AAPL' } }) + '\n');
  assert.deepEqual(await pending[0], { symbol: 'AAPL' });
  assert.deepEqual(received[0], [first, second]);
  assert.equal(child.writes.length, 2);
});

test('progress followed by terminal error rejects safely without poisoning another ID', async t => {
  const child = fakeChild(), api = connectChild(child), events = [];
  t.after(() => closeFake(api, child));
  const rejected = assert.rejects(api.request('market.portfolio.stream', {}, { onProgress: p => events.push(p) }),
    error => error.code === 'internal_error' && !error.message.includes('SECRET'));
  const ordinary = api.request('capabilities');
  child.stdout.write(JSON.stringify({ id: 'ui-1', event: 'progress', data: progressPoint() }) + '\n'
    + JSON.stringify({ id: 'ui-1', ok: false, error: { code: 'SECRET_CODE', message: 'SECRET_PATH' } }) + '\n'
    + JSON.stringify({ id: 'ui-2', ok: true, result: 'still connected' }) + '\n');
  await rejected;
  assert.equal(events.length, 1);
  assert.equal(await ordinary, 'still connected');
  assert.equal(child.writes.length, 2);
});

test('invalid progress protocol closes and rejects all pending without retry or leakage', async t => {
  const valid = { id: 'ui-1', event: 'progress', data: progressPoint() };
  const cases = [
    { ...valid, id: 'other' }, { ...valid, event: 'unknown' }, { ...valid, data: null },
    ...[{ phase: 'unknown' }, { completed: 0 }, { completed: 3 }, { completed: 1.5 },
      { completed: true }, { total: '2' }, { total: 0 }, { total: Number.MAX_SAFE_INTEGER + 1 }]
      .map(change => ({ ...valid, data: { ...valid.data, ...change } })),
  ];
  for (const [index, record] of cases.entries()) await t.test(`malformed record ${index}`, async () => {
    const child = fakeChild(), api = connectChild(child), events = [];
    try {
      const rejected = [api.request('market.backtest.stream', {}, { onProgress: p => events.push(p) }),
        api.request('capabilities')].map(promise => assert.rejects(promise, error => error.code === 'protocol_error'));
      child.stdout.write(JSON.stringify(record) + '\n');
      await Promise.all(rejected);
      assert.deepEqual(events, []);
      assert.equal(child.stdin.writableEnded, true);
      await assert.rejects(api.request('capabilities'), error => error.code === 'closed');
      assert.equal(child.writes.length, 2);
    } finally { await closeFake(api, child); }
  });
});

test('unsolicited progress on ordinary request and progress after terminal are protocol errors', async () => {
  for (const afterTerminal of [false, true]) {
    const child = fakeChild(), api = connectChild(child), failures = [];
    api.on('failure', error => failures.push(error.code));
    try {
      const pending = api.request('market.backtest', {}, afterTerminal ? { onProgress: () => {} } : {});
      const outcome = afterTerminal ? pending : assert.rejects(pending, error => error.code === 'protocol_error');
      if (afterTerminal) child.stdout.write('{"id":"ui-1","ok":true,"result":{}}\n');
      child.stdout.write(JSON.stringify({ id: 'ui-1', event: 'progress', data: progressPoint() }) + '\n');
      await outcome;
      assert.deepEqual(failures, ['protocol_error']);
      assert.equal(child.writes.length, 1);
    } finally { await closeFake(api, child); }
  }
});

test('platform-specific explicit interpreter only; missing environment never spawns', () => {
  const root = path.resolve('test-root');
  assert.equal(interpreterPath(root, 'win32', () => true), path.join(root, '.venv/Scripts/python.exe'));
  assert.equal(interpreterPath(root, 'linux', () => true), path.join(root, '.venv/bin/python'));
  assert.throws(() => createBackend({ root, exists: () => false, spawn: () => assert.fail('must not spawn') }),
    error => error.code === 'missing_interpreter' && error.message.includes('.venv'));
});

test('spawn uses absolute repo interpreter, module, root cwd and shell:false', async () => {
  const child = fakeChild(), root = path.resolve('test-root');
  const api = createBackend({ root, platform: 'win32', exists: () => true, spawn: (command, args, options) => {
    assert.equal(command, path.join(root, '.venv/Scripts/python.exe'));
    assert.deepEqual(args, ['-m', 'itt.rpc']);
    assert.deepEqual(options, { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return child;
  } });
  await closeFake(api, child);
});

test('correlates IDs out of order with fragmented UTF-8 and multiple NDJSON lines', async () => {
  const child = fakeChild(), api = connectChild(child);
  const a = api.request('capabilities'), b = api.request('jobs.status');
  assert.deepEqual(child.writes.map(row => row.id), ['ui-1', 'ui-2']);
  const raw = Buffer.from(JSON.stringify({ id: 'ui-2', ok: true, result: '한국어日本語' }) + '\n'
    + JSON.stringify({ id: 'ui-1', ok: true, result: { rpc: true } }) + '\n');
  const split = raw.indexOf(Buffer.from('한')) + 1;
  child.stdout.write(raw.subarray(0, split));
  child.stdout.write(raw.subarray(split, split + 1));
  child.stdout.write(raw.subarray(split + 1, raw.length - 2));
  child.stdout.write(raw.subarray(raw.length - 2));
  assert.deepEqual(await a, { rpc: true });
  assert.equal(await b, '한국어日本語');
  await closeFake(api, child);
});

test('redacts server errors and stderr without retrying a failed operation', async () => {
  const child = fakeChild(), api = connectChild(child);
  const pending = api.request('decisions.add', { text: 'private-note' });
  const rejected = assert.rejects(pending, error => error.code === 'input_rejected'
    && !error.message.includes('private'));
  child.stderr.write('private-credential-sentinel');
  child.stdout.write(JSON.stringify({ id: 'ui-1', ok: false,
    error: { code: 'input_rejected', message: 'private-credential-sentinel' } }) + '\n');
  await rejected;
  assert.equal(child.writes.length, 1);
  assert.equal(safeError({ code: 'private-secret', message: 'private' }), 'Operation failed (details redacted).');
  await closeFake(api, child);
});

test('process exit rejects every pending request, including a partial response', async () => {
  const child = fakeChild(), api = connectChild(child);
  const rejected = [api.request('research.start'), api.request('runs.list')].map(promise =>
    assert.rejects(promise, error => error.code === 'exited'));
  child.stdout.write('{"id":"ui-1","ok":true');
  child.emit('exit', 1); child.emit('close', 1);
  await Promise.all(rejected);
  await assert.rejects(api.request('jobs.status'), error => error.code === 'closed');
  await api.close();
});

test('malformed/uncorrelated envelopes and truncated EOF stop rather than retry', async () => {
  for (const payload of ['secret-not-json\n', '{"id":"other","ok":true,"result":1}\n', '{"id":']) {
    const child = fakeChild(), api = connectChild(child);
    const rejected = assert.rejects(api.request('capabilities'), error => error.code === 'protocol_error');
    child.stdout.write(payload);
    if (!payload.endsWith('\n')) child.stdout.end();
    await rejected;
    assert.equal(child.writes.length, 1);
    await closeFake(api, child);
  }
});

test('close sends EOF first, rejects pending, and does not kill a graceful child', async () => {
  const child = fakeChild(), api = connectChild(child);
  child.stdin.on('finish', () => { child.emit('exit', 0); child.emit('close', 0); });
  const rejected = assert.rejects(api.request('jobs.status'), error => error.code === 'closed');
  const first = api.close();
  assert.equal(first, api.close());
  await first; await rejected;
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, []);
});

test('close escalates only to the owned child when EOF does not finish it', async () => {
  const child = fakeChild(), api = connectChild(child, { graceMs: 1 });
  const closing = api.close();
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, []);
  await closing;
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('asynchronous spawn and input errors reject without leaking error text', async () => {
  for (const kind of ['spawn', 'input']) {
    const child = fakeChild(), api = connectChild(child);
    const rejected = assert.rejects(api.request('capabilities'), error =>
      error.code === (kind === 'spawn' ? 'spawn_failed' : 'write_failed') && !error.message.includes('SECRET'));
    (kind === 'spawn' ? child : child.stdin).emit('error', new Error('SECRET'));
    await rejected; await closeFake(api, child);
  }
});

test('optional real RPC: capabilities, data validation, start/status/store/replay/notes', { timeout: 30000 }, async t => {
  try { interpreterPath(); } catch { t.skip('Repository .venv interpreter not present.'); return; }
  const temporary = await mkdtemp(path.join(tmpdir(), 'itt-ui-rpc-'));
  const api = createBackend();
  t.after(async () => { await api.close(); await rm(temporary, { recursive: true, force: true }); });
  const capabilities = await api.request('capabilities');
  assert.ok(capabilities.rpc.methods.includes('research.start'));
  assert.equal(capabilities.rpc.events, 'opt_in_correlated_market_progress');
  assert.deepEqual(capabilities.data_kinds, ['real_market_snapshot', 'synthetic']);
  const data = path.join(ROOT, 'tests/fixtures/p2/normal.json'), spec = path.join(ROOT, 'tests/fixtures/p2/spec.json');
  assert.equal((await api.request('data.validate', { path: data })).dataset_id, 'p2-synthetic-normal');
  // No fictional data.start alias: the server's exact start method is research.start.
  await assert.rejects(api.request('data.start'), error => error.code === 'method_not_found');
  const store = path.join(temporary, 'runs');
  const started = await api.request('research.start', { data, spec, store });
  assert.equal(started.status, 'running'); assert.ok(started.job_id);
  let job;
  const deadline = Date.now() + 20000;
  do {
    job = await api.request('jobs.status');
    if (job.status !== 'running') break;
    assert.ok(Date.now() < deadline, 'Research did not finish within test deadline');
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
  assert.equal(job.status, 'completed'); assert.equal(job.job_id, started.job_id);
  const runs = await api.request('runs.list', { store });
  assert.equal(runs.length, 1); assert.equal(runs[0].id, job.run_id);
  const params = { store, id: job.run_id };
  const bundle = await api.request('runs.show', params);
  assert.equal(bundle.result.synthetic, true);
  assert.deepEqual(bundle.result.strategy.metrics, runs[0].metrics.strategy);
  assert.equal(typeof bundle.result.strategy.metrics.final_nav, 'string');
  const replay = await api.request('runs.replay', params);
  assert.equal(replay.status, 'verified'); assert.deepEqual(replay.result, bundle.result);
  const text = '결정 메모 / 判断記録 / explicit decision, not an NL command';
  const note = await api.request('decisions.add', { ...params, text });
  const notes = await api.request('decisions.list', params);
  assert.equal(notes[0].id, note.decision_id); assert.equal(notes[0].text, text);
});