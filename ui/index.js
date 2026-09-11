import kit from 'terminal-kit';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackend, ROOT, safeError } from './backend.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const sanitize = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
export function fit(value, width) {
  let text = '', used = 0;
  for (const { segment } of graphemes.segment(sanitize(value))) {
    const cells = kit.stringWidth(segment);
    if (used + cells > Math.max(0, width)) break;
    text += segment; used += cells;
  }
  return text;
}
export function wrap(value, width) {
  const lines = []; let line = '', used = 0;
  for (const { segment } of graphemes.segment(sanitize(value))) {
    const cells = kit.stringWidth(segment);
    if (cells > width) continue;
    if (used + cells > width) { lines.push(line); line = ''; used = 0; }
    line += segment; used += cells;
  }
  return [...lines, line];
}
export function layout(width, height) {
  return { narrow: width < 100 || height < 30, left: 2, right: 36, top: 11,
    rows: Math.max(1, height - 15), panelWidth: Math.max(1, width - 37), width, height };
}
export function reduce(state, action) {
  if (action.type === 'select') return { ...state, selected: Math.max(0,
    Math.min(state.runs.length - 1, action.index)), offset: 0, bundle: null, notes: [] };
  if (action.type === 'tab') return { ...state, tab: action.tab, offset: 0 };
  if (action.type === 'scroll') return { ...state, offset: Math.max(0,
    Math.min(action.max, state.offset + action.delta)) };
  return state;
}
// Only visualization uses Number: metrics below remain the engine's Decimal strings.
export function navChart(result, width = 55, height = 5) {
  const a = result?.strategy?.daily, b = result?.benchmark?.daily;
  if (!Array.isArray(a) || !a.length || !Array.isArray(b) || a.length !== b.length) return ['Daily NAV unavailable.'];
  const numeric = value => (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
  if (a.some((row, i) => !row || row.date !== b[i]?.date) || [...a, ...b].some(row =>
    !row || !numeric(row.nav) || !Number.isFinite(Number(row.nav)) || Number(row.nav) < 0)) return ['Daily NAV unavailable: invalid samples.'];
  width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
  const values = [...a, ...b].map(row => Number(row.nav));
  const max = values.reduce((high, value) => Math.max(high, value), 0);
  const grid = Array.from({ length: height }, () => Array(width).fill(' '));
  [a, b].forEach((series, index) => series.forEach((row, i) => {
    const x = Math.round(i * (width - 1) / Math.max(1, series.length - 1));
    const y = height - 1 - Math.min(height - 1, Math.max(0,
      Math.round((max === 0 ? 0 : Number(row.nav) / max) * (height - 1))));
    const mark = index ? 'B' : 'S';
    grid[y][x] = grid[y][x] === ' ' || grid[y][x] === mark ? mark : '#';
  }));
  return [`Daily NAV | S strategy B benchmark # overlap | 0..${max}`,
    ...grid.map(row => `|${row.join('')}|`), `+${'-'.repeat(width)}+`,
    `${sanitize(a[0].date)} -> ${sanitize(a.at(-1).date)} (sample points; no interpolation)`];
}
export function resultLines(bundle, width) {
  if (!bundle) return ['Select a saved run or Run Baseline.', 'No financial values are invented while loading.'];
  const result = bundle.result;
  const lines = [...navChart(result, width - 2)];
  for (const name of ['strategy', 'benchmark']) {
    lines.push(name === 'strategy' ? 'STRATEGY (saved engine result)' : 'BENCHMARK (equal-weight buy-and-hold)');
    for (const [key, label] of [['initial_nav', 'Initial NAV'], ['final_nav', 'Final NAV'],
      ['total_return', 'Return (ratio)'], ['max_drawdown', 'MDD (ratio)'], ['fees', 'Fees']]) {
      lines.push(...wrap(`${label}: ${result?.[name]?.metrics?.[key] ?? 'unavailable'}`, width));
    }
  }
  lines.push('Daily NAV values: strategy / benchmark');
  for (const [i, row] of (result?.strategy?.daily ?? []).entries()) {
    lines.push(...wrap(`${row.date}: ${row.nav} / ${result?.benchmark?.daily?.[i]?.nav ?? 'unavailable'}`, width));
  }
  return lines;
}

const buttons = [['b', 'Run Baseline'], ['r', 'Refresh runs'], ['p', 'Replay selected'], ['c', 'Cancel'], ['n', 'Add note']];
const tabs = ['result', 'notes', 'log'];
export function startUI({ term = kit.terminal, backend, backendFactory = createBackend, root = ROOT,
  schedule = setTimeout, unschedule = clearTimeout, signals = process } = {}) {
  const paths = { data: path.join(root, 'tests/fixtures/p2/normal.json'), spec: path.join(root, 'tests/fixtures/p2/spec.json'),
    store: path.join(root, '.itt/runs') };
  let state = { runs: [], selected: 0, tab: 'result', offset: 0, bundle: null, notes: [],
    logs: ['Synthetic UI source only; product completion and physical interaction not verified.'],
    job: null, busy: '', error: '', ready: false };
  let stopped = false, closePromise, timer, field, noteRun, editing = false, generation = 0, hits = [];
  const selectedId = () => state.runs[state.selected]?.id;
  const update = action => { state = reduce(state, action); };
  const log = text => { state.logs.push(sanitize(text)); };
  const report = error => { state.error = safeError(error); log(state.error); draw(); };
  function lines() {
    const width = layout(term.width, term.height).panelWidth;
    if (state.tab === 'result') return resultLines(state.bundle, width);
    if (state.tab === 'notes') return state.notes.length ? state.notes.flatMap(note =>
      [sanitize(note.created_at), ...wrap(note.text, width), '']) : ['No decision notes for this run.'];
    return state.logs.flatMap(line => wrap(line, width));
  }
  function draw() {
    if (stopped) return;
    const box = layout(term.width, term.height);
    const put = (x, y, text, color = 'white', width = term.width - x) => {
      if (y < 1 || y > term.height || x >= term.width) return;
      term.moveTo(x, y); term[color].noFormat(fit(text, width));
    };
    term.clear(); hits = [];
    if (box.narrow) {
      put(1, 1, 'Resize to at least 100 x 30. Esc / Ctrl-C exits.', 'yellow');
      if (editing) put(1, 2, 'Esc cancels note first; Ctrl-C exits immediately.', 'yellow');
      if (state.error) put(1, 3, state.error, 'red');
      return;
    }
    put(2, 1, 'INTELLIGENCE INVESTMENT TERMINAL | SYNTHETIC RESEARCH', 'cyan');
    put(2, 2, 'SYNTHETIC / NO LIVE DATA | OpenAI / Azure OpenAI / GitHub Copilot: NOT CONNECTED', 'yellow');
    put(2, 3, 'Tokens: no recorded calls | Cost: unknown | No live orders | No external audit', 'yellow');
    put(2, 4, 'Baseline: tests/fixtures/p2/normal.json + spec.json | Store: .itt/runs', 'cyan');
    put(2, 5, 'M: REAL Yahoo market viewer | CJK font / IME / physical mouse evaluation: UNVERIFIED');
    let x = 2;
    for (const [key, label] of buttons) {
      const text = `[${key.toUpperCase()} ${label}]`;
      put(x, 7, text, 'cyan'); hits.push({ x, end: x + text.length - 1, y: 7, key }); x += text.length + 1;
    }
    put(2, 8, `Job: ${state.job?.status ?? 'not queried'} | Phase: ${state.job?.phase ?? 'not reported'} | ${state.busy}`, 'yellow');
    put(2, 9, state.error ? `ERROR: ${state.error}` : `Run: ${selectedId() ?? 'none'}`, state.error ? 'red' : 'cyan');
    put(2, 10, `SAVED RUNS (${state.runs.length})`, 'blue');
    x = box.right;
    tabs.forEach((tab, i) => {
      const text = `[${i + 1} ${tab.toUpperCase()}${state.tab === tab ? '*' : ''}]`;
      put(x, 10, text, state.tab === tab ? 'cyan' : 'blue');
      hits.push({ x, end: x + text.length - 1, y: 10, tab }); x += text.length + 1;
    });
    const first = Math.max(0, state.selected - box.rows + 1);
    if (!state.runs.length) put(2, box.top, 'No saved runs.', 'white', 32);
    state.runs.slice(first, first + box.rows).forEach((run, i) => {
      const index = first + i;
      put(2, box.top + i, `${index === state.selected ? '>' : ' '} ${sanitize(run.id).slice(0, 8)} ${run.created_at}`, index === state.selected ? 'cyan' : 'white', 32);
      hits.push({ x: 2, end: 33, y: box.top + i, index });
    });
    const content = lines(); state.offset = Math.min(state.offset, Math.max(0, content.length - box.rows));
    content.slice(state.offset, state.offset + box.rows).forEach((line, i) => put(box.right, box.top + i, line));
    put(2, term.height - 3, `Up/Down runs | 1/2/3 panels | PgUp/PgDn/wheel scroll | Esc/Ctrl-C exit | ${state.offset + 1}/${content.length}`, 'cyan');
    put(2, term.height - 2, editing ? `DECISION NOTE ${noteRun} | Enter save / Esc cancel (not NL)` : 'N: Add decision note (not natural-language commands). Replay occupies the single RPC process.', 'yellow');
    if (editing && field) {
      const chars = [...field.getInput()], cursor = field.getCursorPosition();
      let before = sanitize(chars.slice(0, cursor).join(''));
      while (kit.stringWidth(before) > term.width - 8) before = [...graphemes.segment(before)].slice(1).map(s => s.segment).join('');
      put(2, term.height - 1, `${before}|${chars.slice(cursor).join('')}`, 'cyan');
    }
    term.styleReset();
  }
  async function loadSelected() {
    const id = selectedId(), current = ++generation;
    state.bundle = null; state.notes = []; draw();
    if (!id) return;
    const [bundle, notes] = await Promise.all([
      backend.request('runs.show', { store: paths.store, id }),
      backend.request('decisions.list', { store: paths.store, id }),
    ]);
    if (!stopped && current === generation && id === selectedId()) { state.bundle = bundle; state.notes = notes; draw(); }
  }
  async function refresh(id = selectedId()) {
    const runs = await backend.request('runs.list', { store: paths.store });
    if (stopped) return;
    state.runs = runs;
    update({ type: 'select', index: Math.max(0, runs.findIndex(run => run.id === id)) });
    await loadSelected();
  }
  function pollLater() {
    unschedule(timer);
    if (!stopped) timer = schedule(() => { timer = undefined; void poll().catch(report); }, 250);
  }
  async function poll() {
    if (stopped) return;
    const job = await backend.request('jobs.status');
    if (stopped) return;
    state.job = job; draw();
    if (job.status === 'running') pollLater();
    else if (job.status === 'completed') { log('Research completed; loading saved result.'); await refresh(job.run_id); }
    else if (job.status === 'failed') report(job.error);
  }
  async function operation(label, work) {
    if (stopped || !state.ready || state.busy) return;
    state.busy = label; state.error = ''; draw();
    try { await work(); } catch (error) { report(error); }
    finally { state.busy = ''; draw(); }
  }
  function addNote() {
    const id = selectedId();
    if (!id) { log('Select a saved run before adding a decision note.'); draw(); return; }
    noteRun = id; editing = true; draw();
    // Documented inputField controller; echo disabled so ALL text passes our safe drawing path.
    field = term.inputField({ x: 2, y: term.height - 1, echo: false, cancelable: true, maxLength: 2048 }, (error, text) => {
      editing = false; field = undefined;
      if (stopped) return;
      if (error) { report(error); return; }
      if (text === undefined) { log('Decision note cancelled (not saved).'); draw(); return; }
      text = sanitize(text);
      if (!text.trim()) { log('Decision note is empty; nothing saved.'); draw(); return; }
      void operation('Saving decision note', async () => {
        await backend.request('decisions.add', { store: paths.store, id, text });
        log('Decision note saved.');
        if (id === selectedId()) { update({ type: 'tab', tab: 'notes' }); await loadSelected(); }
      });
    });
    draw();
  }
  async function action(key) {
    if (!state.ready || editing || state.busy || stopped) return;
    if (key === 'm') {
      await close();
      const { startMarketUI } = await import('./market.js');
      startMarketUI({ root });
      return;
    }
    if (key === 'n') { addNote(); return; }
    if (key === 'b' && state.job?.status !== 'running') await operation('Starting baseline', async () => {
      const job = await backend.request('research.start', paths);
      state.job = { ...job, phase: null }; log('Baseline accepted; polling actual job status.'); pollLater();
    });
    if (key === 'r') await operation('Refreshing runs', () => refresh());
    if (key === 'c' && state.job?.status === 'running') await operation('Requesting cancellation', async () => {
      const job = await backend.request('jobs.cancel', { job_id: state.job.job_id });
      state.job = { ...job, phase: null }; log('Cancellation accepted.');
    });
    if (key === 'p' && selectedId()) await operation('Replay: RPC busy; keyboard remains responsive', async () => {
      const id = selectedId(); log('Replay runs synchronously inside the one RPC process; other RPC responses may wait.');
      const replay = await backend.request('runs.replay', { store: paths.store, id });
      log(`Replay ${id}: ${sanitize(replay.status)} (exact saved-result equality, not an external audit).`);
      if (id === selectedId()) { update({ type: 'tab', tab: 'log' }); }
    });
  }
  function select(index) { update({ type: 'select', index }); void loadSelected().catch(report); }
  function scroll(delta) { update({ type: 'scroll', delta, max: Math.max(0, lines().length - layout(term.width, term.height).rows) }); draw(); }
  function onKey(key) {
    if (key === 'CTRL_C') { void close(); return; }
    if (editing) { queueMicrotask(draw); return; } // inputField owns Enter/Esc/editing keys.
    if (key === 'ESCAPE') { void close(); return; }
    if (layout(term.width, term.height).narrow) return;
    if (key === 'UP' || key === 'DOWN') select(state.selected + (key === 'UP' ? -1 : 1));
    else if (['1', '2', '3'].includes(key)) { update({ type: 'tab', tab: tabs[Number(key) - 1] }); draw(); }
    else if (key === 'PAGE_UP' || key === 'PAGE_DOWN') scroll((key === 'PAGE_UP' ? -1 : 1) * layout(term.width, term.height).rows);
    else void action(key.toLowerCase());
  }
  function onMouse(key, data) {
    if (editing || layout(term.width, term.height).narrow) return;
    if (key === 'MOUSE_WHEEL_UP' || key === 'MOUSE_WHEEL_DOWN') {
      const delta = key === 'MOUSE_WHEEL_UP' ? -1 : 1;
      if (data.x < 35) select(state.selected + delta); else scroll(delta * 3);
    }
    if (key !== 'MOUSE_LEFT_BUTTON_PRESSED') return;
    const hit = hits.find(hit => data.y === hit.y && data.x >= hit.x && data.x <= hit.end);
    if (hit?.key) void action(hit.key);
    else if (hit?.tab) { update({ type: 'tab', tab: hit.tab }); draw(); }
    else if (hit?.index !== undefined) select(hit.index);
  }
  function onResize() { draw(); }
  function close() {
    if (closePromise) return closePromise;
    stopped = true; unschedule(timer); field?.abort(); editing = false;
    term.removeListener('key', onKey); term.removeListener('mouse', onMouse); term.removeListener('resize', onResize);
    signals.removeListener('SIGINT', onSignal); backend?.removeListener?.('failure', report);
    term.grabInput(false); term.hideCursor(false); term.styleReset(); term.fullscreen(false);
    closePromise = Promise.resolve(backend?.close());
    return closePromise;
  }
  const onSignal = () => { void close(); };
  term.fullscreen(true); term.grabInput({ mouse: 'button' }); term.hideCursor(true);
  term.on('key', onKey); term.on('mouse', onMouse); term.on('resize', onResize); signals.on('SIGINT', onSignal);
  const ready = (async () => {
    try {
      backend ??= backendFactory({ root }); backend.on?.('failure', report);
      await backend.request('capabilities');
      if (stopped) return;
      await refresh(); await poll();
      if (!stopped) state.ready = true;
    } catch (error) { report(error); }
  })();
  draw();
  return { get state() { return state; }, ready, action, close, draw };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Interactive terminal required (at least 100 x 30).'); process.exitCode = 2;
  } else startUI();
}