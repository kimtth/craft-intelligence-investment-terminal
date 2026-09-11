// Mock handlers prove source contracts only, never physical Windows mouse/font/IME behavior.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { kit } from './helpers/dependencies.js';
import { startUI, sanitize, fit, wrap, layout, reduce, navChart, resultLines } from '../../ui/index.js';

const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const metrics = { initial_nav: '1000', final_nav: '777', total_return: '0.12345678901234567890', max_drawdown: '0.09', fees: '19' };
const bundle = { result: { strategy: { metrics, daily: [{ date: '2024-01-02', nav: '1000' }, { date: '2024-01-03', nav: '900' }] },
  benchmark: { metrics: { ...metrics, final_nav: '888' }, daily: [{ date: '2024-01-02', nav: '1000' }, { date: '2024-01-03', nav: '950' }] } } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fakeTerm() {
  const term = new EventEmitter(), output = [], modes = [];
  Object.assign(term, { width: 100, height: 30, output, modes,
    clear() {}, moveTo(x, y) { assert.ok(x >= 1 && x <= term.width); assert.ok(y >= 1 && y <= term.height); },
    styleReset() {}, fullscreen(value) { modes.push(['fullscreen', value]); },
    grabInput(value) { modes.push(['grabInput', value]); }, hideCursor(value) { modes.push(['hideCursor', value]); } });
  for (const color of ['white', 'cyan', 'yellow', 'blue', 'red']) term[color] = { noFormat(text) {
    assert.equal(sanitize(text), text, 'no terminal controls in displayed text'); output.push({ text, color });
  } };
  term.inputField = (options, callback) => {
    assert.equal(options.echo, false); assert.equal(options.cancelable, true);
    let value = '';
    const abort = () => term.removeListener('key', onKey);
    const onKey = (key, matches, data) => {
      if (key === 'ESCAPE') { abort(); callback(undefined, undefined); }
      else if (key === 'ENTER') { abort(); callback(undefined, value); }
      else if (data?.isCharacter) value += key;
    };
    term.on('key', onKey);
    return { abort, getInput: () => value, getCursorPosition: () => [...value].length };
  };
  return term;
}
function fakeBackend(overrides = {}) {
  const backend = new EventEmitter(); backend.calls = []; backend.closed = 0;
  backend.request = async (method, params = {}) => {
    backend.calls.push({ method, params });
    if (overrides[method]) return overrides[method](params);
    if (method === 'capabilities') return { rpc: { methods: ['research.start'] } };
    if (method === 'runs.list') return ids.map((id, i) => ({ id, created_at: `2024-01-0${i + 2}`, kind: 'synthetic' }));
    if (method === 'runs.show') return bundle;
    if (method === 'decisions.list') return [];
    if (method === 'jobs.status') return { status: 'idle', phase: null, job_id: null };
    if (method === 'research.start') return { status: 'running', job_id: ids[0] };
    if (method === 'jobs.cancel') return { status: 'cancelled', job_id: ids[0] };
    if (method === 'runs.replay') return { status: 'verified', id: params.id, result: bundle.result };
    if (method === 'decisions.add') return { decision_id: ids[1] };
    assert.fail(`Unexpected RPC: ${method}`);
  };
  backend.close = async () => { backend.closed++; };
  return backend;
}
function setup(overrides = {}, options = {}) {
  const term = fakeTerm(), backend = fakeBackend(overrides), scheduled = new Map(); let sequence = 0;
  const ui = startUI({ term, backend, signals: new EventEmitter(), root: path.resolve('ui-test-root'),
    schedule(callback, delay) { assert.equal(delay, 250); scheduled.set(++sequence, callback); return sequence; },
    unschedule(id) { scheduled.delete(id); }, ...options });
  return { ui, term, backend, scheduled };
}

test('pure layout/reducer and grapheme cell fitting; no physical font claim', () => {
  assert.equal(layout(100, 30).narrow, false); assert.equal(layout(99, 30).narrow, true);
  assert.equal(layout(100, 29).narrow, true);
  assert.equal(fit('한국어日本語', 8), '한국어日');
  const combined = 'e\u0301', width = kit.stringWidth(combined);
  assert.equal(fit(combined + 'Z', width), combined);
  assert.equal(fit('👩‍💻X', kit.stringWidth('👩‍💻')), '👩‍💻');
  assert.deepEqual(wrap('日本語', 4), ['日本', '語']);
  const state = { runs: [{}, {}], selected: 0, offset: 0 };
  assert.equal(reduce(state, { type: 'select', index: 99 }).selected, 1);
  assert.equal(reduce(state, { type: 'scroll', delta: -2, max: 10 }).offset, 0);
  assert.equal(reduce(state, { type: 'scroll', delta: 99, max: 10 }).offset, 10);
  assert.equal(state.selected, 0);
});

test('NAV plot handles zero, constant, single, invalid and negative samples without fabricated metrics', () => {
  for (const value of ['0', '1000']) {
    const one = { strategy: { daily: [{ date: 'd', nav: value }] }, benchmark: { daily: [{ date: 'd', nav: value }] } };
    assert.ok(navChart(one, 8, 3).join('').includes('#'));
    assert.equal(navChart(one, 8, 3).length, 6);
  }
  for (const value of ['-1', 'NaN', 'Infinity', null, '']) {
    const invalid = structuredClone(bundle.result); invalid.strategy.daily[0].nav = value;
    assert.match(navChart(invalid).join(''), /unavailable/);
  }
  assert.deepEqual(navChart(null), ['Daily NAV unavailable.']);
  const text = resultLines(bundle, 100).join('\n');
  assert.ok(text.includes('Final NAV: 777')); assert.ok(text.includes('Final NAV: 888'));
  assert.ok(text.includes('Return (ratio): 0.12345678901234567890'));
  assert.ok(text.includes('MDD (ratio): 0.09')); assert.ok(text.includes('Fees: 19'));
  // These metrics deliberately disagree with the daily samples: the UI must not recompute them.
  assert.ok(!text.includes('Return (ratio): -0.1'));
});

test('mouse/keyboard run selection, tabs, scrolling and clean terminal restoration', async () => {
  const { ui, term, backend } = setup(); await ui.ready;
  assert.ok(term.output.some(row => row.text.includes('SYNTHETIC / NO LIVE DATA')));
  assert.ok(term.output.some(row => row.text.includes('NOT CONNECTED')));
  term.emit('key', 'DOWN'); await tick(); assert.equal(ui.state.selected, 1);
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 4, y: 11 }); await tick(); assert.equal(ui.state.selected, 0);
  term.emit('mouse', 'MOUSE_WHEEL_DOWN', { x: 50, y: 16 }); assert.ok(ui.state.offset > 0);
  term.emit('key', 'PAGE_UP'); assert.equal(ui.state.offset, 0);
  term.emit('key', '2'); assert.equal(ui.state.tab, 'notes');
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 37, y: 10 }); assert.equal(ui.state.tab, 'result');
  term.emit('key', 'CTRL_C'); await ui.close();
  assert.equal(backend.closed, 1); assert.equal(term.listenerCount('key'), 0);
  assert.deepEqual(term.modes.slice(-3), [['grabInput', false], ['hideCursor', false], ['fullscreen', false]]);
});

test('baseline toolbar uses exact paths, polls 250ms, displays actual phase then loads completed run', async () => {
  let status = { status: 'idle', phase: null };
  const { ui, term, backend, scheduled } = setup({ 'jobs.status': () => status }); await ui.ready;
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 4, y: 7 }); await tick();
  const start = backend.calls.find(call => call.method === 'research.start');
  assert.deepEqual(start.params, { data: path.resolve('ui-test-root/tests/fixtures/p2/normal.json'),
    spec: path.resolve('ui-test-root/tests/fixtures/p2/spec.json'), store: path.resolve('ui-test-root/.itt/runs') });
  assert.equal(ui.state.job.phase, null); assert.equal(scheduled.size, 1);
  status = { status: 'running', phase: 'calculating', job_id: ids[0] };
  let [id, callback] = scheduled.entries().next().value; scheduled.delete(id); callback(); await tick();
  assert.equal(ui.state.job.phase, 'calculating'); assert.equal(scheduled.size, 1);
  status = { status: 'completed', phase: 'completed', job_id: ids[0], run_id: ids[1] };
  [id, callback] = scheduled.entries().next().value; scheduled.delete(id); callback(); await tick();
  assert.equal(ui.state.selected, 1); assert.equal(ui.state.bundle, bundle); assert.equal(scheduled.size, 0);
  assert.equal(backend.calls.filter(call => call.method === 'research.start').length, 1);
  await ui.close();
});

test('Cancel sends current job ID; replay waits asynchronously without blocking handlers', async () => {
  const replay = deferred();
  const { ui, term, backend } = setup({ 'runs.replay': () => replay.promise }); await ui.ready;
  await ui.action('b'); await ui.action('c');
  assert.deepEqual(backend.calls.find(call => call.method === 'jobs.cancel').params, { job_id: ids[0] });
  const work = ui.action('p');
  term.emit('key', '3'); assert.equal(ui.state.tab, 'log');
  term.emit('key', 'PAGE_DOWN'); assert.ok(ui.state.busy.includes('Replay'));
  await ui.action('p'); // No duplicate operation while in flight.
  assert.equal(backend.calls.filter(call => call.method === 'runs.replay').length, 1);
  replay.resolve({ status: 'verified' }); await work;
  assert.ok(ui.state.logs.some(line => line.includes('exact saved-result equality')));
  await ui.close();
});

test('decision input Enter saves selected run, Esc cancels, text is literal and sanitized', async () => {
  const { ui, term, backend } = setup(); await ui.ready;
  await ui.action('n');
  term.emit('key', '\x1b]52;clipboard\x07한국어 日本語 %s ^r', [], { isCharacter: true }); await tick();
  term.emit('key', 'ENTER'); await tick();
  const note = backend.calls.find(call => call.method === 'decisions.add');
  assert.equal(note.params.id, ids[0]); assert.equal(note.params.text, ']52;clipboard한국어 日本語 %s ^r');
  assert.equal(ui.state.tab, 'notes');
  await ui.action('n'); term.emit('key', 'ESCAPE'); await tick();
  assert.equal(backend.calls.filter(call => call.method === 'decisions.add').length, 1);
  assert.equal(backend.closed, 0);
  await ui.close(); assert.equal(term.listenerCount('key'), 0);
});

test('late selected-run responses cannot overwrite newer selection', async () => {
  const slow = deferred(); let first = true;
  const { ui, term } = setup({ 'runs.show': ({ id }) => {
    if (first) { first = false; return bundle; }
    return id === ids[1] ? slow.promise : bundle;
  } });
  await ui.ready; term.emit('key', 'DOWN'); term.emit('key', 'UP'); await tick();
  slow.resolve({ result: { bogus: true } }); await tick();
  assert.equal(ui.state.bundle, bundle); assert.equal(ui.state.selected, 0); await ui.close();
});

test('notes and log scroll independently; Ctrl-C aborts an open input controller', async () => {
  const { ui, term, backend } = setup({ 'decisions.list': () => [
    { created_at: '2024-01-02', text: '\x1b[31m' + '日本語 '.repeat(300) },
  ] });
  await ui.ready; term.emit('key', '2');
  term.emit('mouse', 'MOUSE_WHEEL_DOWN', { x: 50, y: 15 }); assert.ok(ui.state.offset > 0);
  term.emit('key', '3'); assert.equal(ui.state.offset, 0);
  ui.state.logs.push(...Array.from({ length: 40 }, (_, i) => `Log ${i}`));
  term.emit('key', 'PAGE_DOWN'); assert.ok(ui.state.offset > 0);
  await ui.action('n'); term.emit('key', 'CTRL_C'); await ui.close();
  assert.equal(term.listenerCount('key'), 0);
  assert.equal(backend.calls.filter(call => call.method === 'decisions.add').length, 0);
});

test('poll failure is visible/redacted and stops automatic polling; no write retry', async () => {
  let fail = false;
  const { ui, term, scheduled, backend } = setup({ 'jobs.status': () => {
    if (fail) throw Object.assign(new Error('SECRET'), { code: 'worker_failed' });
    return { status: 'idle', phase: null };
  } });
  await ui.ready; await ui.action('b'); fail = true;
  const [id, callback] = scheduled.entries().next().value; scheduled.delete(id); callback(); await tick();
  assert.equal(scheduled.size, 0); assert.ok(ui.state.error.includes('Research worker'));
  assert.ok(term.output.some(row => row.color === 'red')); assert.ok(!JSON.stringify(term.output).includes('SECRET'));
  assert.equal(backend.calls.filter(call => call.method === 'research.start').length, 1); await ui.close();
});

test('narrow resize still permits note cancellation and Escape shutdown', async () => {
  const { ui, term, backend } = setup(); await ui.ready; await ui.action('n');
  term.width = 60; term.height = 20; term.emit('resize');
  assert.ok(term.output.some(row => row.text.includes('Resize to at least')));
  term.emit('key', 'ESCAPE'); assert.equal(backend.closed, 0);
  term.emit('key', 'ESCAPE'); await ui.close(); assert.equal(backend.closed, 1);
});

test('missing interpreter remains a clear visible startup failure with working exit', async () => {
  const term = fakeTerm();
  const ui = startUI({ term, signals: new EventEmitter(), backendFactory() {
    throw Object.assign(new Error('SECRET'), { code: 'missing_interpreter' });
  } });
  await ui.ready; assert.equal(ui.state.ready, false);
  assert.ok(ui.state.error.includes('.venv')); assert.ok(!ui.state.error.includes('SECRET'));
  term.emit('key', 'CTRL_C'); await ui.close(); assert.equal(term.listenerCount('key'), 0);
});