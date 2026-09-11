import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../ui/backend.js';
import { buildCopilotService, buildSnapshotContext, validateCopilotRequest, copilotError,
  TRANSPORT_TIMEOUT_MS } from '../../ui/copilot.js';
import { parseCopilotArgs, runCopilotCLI } from '../../ui/copilot-cli.js';
import { criterion, CRITERIA_LIMITS } from '../../ui/criteria-schema.js';
import { spawnSync } from 'node:child_process';

// All SDK calls in this file are mocks: no authentication or model invocation.
const ARCHIVE = '77777777-7777-4777-8777-777777777777';
const params = () => ({ symbol: 'QQQ', timestamp: 102, archiveId: ARCHIVE,
  model: 'test-model', question: '  이 구간을 설명해 주세요  ' });
function snapshot() {
  return {
    manifest: { id: ARCHIVE, provider: 'Yahoo Finance', collected_at: '2026-09-10T00:00:00Z',
      raw_sha256: { 'raw-QQQ.json': 'a'.repeat(64), 'raw-SPY.json': 'b'.repeat(64) },
      request_urls: { QQQ: 'https://do-not-send.example' }, privatePath: 'PRIVATE_PATH' },
    symbols: [{ symbol: 'QQQ', currency: 'USD', date_basis: 'exchange_timezone',
      price_basis: 'provider chart close (not total return; split adjustment possible)',
      bars: [101, 102, 103].map((timestamp, i) => ({ timestamp, date: `2026-09-0${i + 1}`,
        open: '10', high: '12', low: '9', close: i === 2 ? '999999' : '11', volume: '100', secret: 'BAR_SECRET' })),
      technicals: { version: '1', basis: 'provider_close', sma20: [null, '11', 'FUTURE_SMA'],
        sma50: [null, null, null], rsi14: [null, '50', 'FUTURE_RSI'], private: 'TECH_SECRET' },
      events: { private: 'EVENT_SECRET' }, notes: 'PRIVATE_NOTES' },
    { symbol: 'SPY', bars: [{ close: 'OTHER_SYMBOL' }] }],
    summary: [{ last_price: 'SUMMARY_FUTURE' }],
  };
}
// Independent expected allowlist, matching the Python indicator contract.
const SERIES_KEYS = [
  'sma5', 'sma10', 'sma20', 'sma50', 'sma100', 'sma200',
  'ema5', 'ema10', 'ema20', 'ema50', 'ema100', 'ema200',
  'stoch9_6', 'stochrsi14', 'macd12_26', 'macd_signal9', 'adx14', 'plus_di14', 'minus_di14',
  'williams_r14', 'cci14', 'atr14', 'highs_lows14', 'ultimate7_14_28', 'roc12', 'bull13', 'bear13',
];
function expandedSnapshot() {
  const value = snapshot();
  const technicals = value.symbols[0].technicals;
  technicals.series = Object.fromEntries(SERIES_KEYS.map((key, i) => [key, [null, String(i), '987654321']]));
  technicals.definitions = Object.fromEntries(SERIES_KEYS.map(key =>
    [key, `${key} test formula; local formula, no Investing.com parity guaranteed`]));
  technicals.definitions.highs_lows14 = 'custom C-(highestH14+lowestL14)/2; explicitly not an Investing.com replica'
    + '; local formula, no Investing.com parity guaranteed';
  return value;
}
function mock({ authenticated = true, events = [], answer = 'Observed facts [bar:QQQ:102].',
  fail, stopErrors = [], send, create, market, auth } = {}) {
  const calls = [];
  const state = { calls, options: undefined, config: undefined, prompt: undefined };
  const rawError = () => Object.assign(new Error('TOKEN=DO_NOT_LEAK /private/account'), { code: 'SDK_SECRET_CODE' });
  let handlers = [];
  const session = {
    on(handler) { handlers.push(handler); return () => { calls.push('unsubscribe'); handlers = []; }; },
    async sendAndWait(message, timeout) {
      calls.push('send'); state.prompt = message.prompt;
      assert.equal(timeout, TRANSPORT_TIMEOUT_MS);
      for (const event of events) { state.config.onEvent(event); for (const handler of handlers) handler(event); }
      if (fail === 'send') throw rawError();
      if (send) return send(state);
      return answer === undefined ? undefined : { data: { content: answer } };
    },
    async abort() { calls.push('abort'); if (fail === 'abort') throw rawError(); },
    async disconnect() { calls.push('disconnect'); if (fail === 'disconnect') throw rawError(); },
  };
  const client = {
    async start() { calls.push('start'); if (fail === 'start') throw rawError(); },
    async getAuthStatus() { calls.push('auth'); if (fail === 'auth') throw rawError();
      if (auth) return auth();
      return { isAuthenticated: authenticated, login: 'test-account', host: 'github.com', authType: 'user',
        statusMessage: 'TOKEN=DO_NOT_LEAK', token: 'DO_NOT_LEAK' }; },
    async listModels() { calls.push('models'); if (fail === 'models') throw rawError();
      return [{ id: 'test-model', name: 'Test Model', billing: { multiplier: 999 }, secret: 'PRIVATE_MODEL' }]; },
    async createSession(config) {
      calls.push('create'); state.config = config;
      if (fail === 'create') throw rawError();
      if (create) return create(config, session);
      return session;
    },
    async deleteSession(id) { calls.push(['delete', id]); if (fail === 'delete') throw rawError(); },
    async stop() { calls.push('stop'); if (fail === 'stop') throw rawError(); return stopErrors; },
    async forceStop() { calls.push('forceStop'); },
  };
  const service = buildCopilotService({
    backend: { async request(...args) { calls.push(['market', ...args]); return market ? market() : snapshot(); } },
    clientFactory: async options => { calls.push('factory'); state.options = options; return client; },
  });
  return { ...state, state, service };
}
const code = expected => error => {
  assert.equal(error.code, expected);
  assert.doesNotMatch(JSON.stringify(copilotError(error)), /DO_NOT_LEAK|PRIVATE|SDK_SECRET/);
  return true;
};
function deleted(state) {
  assert.equal(existsSync(path.dirname(state.options.baseDirectory)), false);
}

test('lazy service; strict allowlist and false consent have zero SDK and market actions', async () => {
  const { service, calls } = mock();
  assert.deepEqual(calls, []);
  for (const method of ['analyze', 'criteria']) {
    await assert.rejects(service[method]({ ...params(), consent: false }), code('consent_required'));
    for (const change of [{ store: '/bad' }, { symbol: '../AAPL' }, { timestamp: 1.5 },
      { timestamp: '102' }, { archiveId: '-'.repeat(36) }, { model: '' },
      { question: ' '.repeat(10) }, { question: 'x'.repeat(4001) }, { consent: 'true' },
      { consent: null }, { consent: undefined }]) {
      await assert.rejects(service[method]({ ...params(), ...change }), code('invalid_request'));
    }
    for (const key of Object.keys(params())) {
      const incomplete = params();
      delete incomplete[key];
      await assert.rejects(service[method](incomplete), code('invalid_request'));
    }
  }
  assert.deepEqual(calls, []);
  assert.throws(() => validateCopilotRequest('copilot.status', { model: 'x' }));
  assert.throws(() => validateCopilotRequest('copilot.shell', {}));
  await service.close();
  await assert.rejects(service.status(), code('closed'));
});

test('explicit status projects safe account identity and models, never starts a session', async () => {
  for (const authenticated of [true, false]) {
    const { service, state, calls } = mock({ authenticated });
    const result = await service.status();
    assert.equal(result.status, authenticated ? 'ready' : 'not_authenticated');
    assert.equal(result.authenticated, authenticated);
    assert.deepEqual(result.identity, { login: 'test-account', host: 'github.com', authType: 'user' });
    assert.deepEqual(result.models, authenticated ? [{ id: 'test-model', name: 'Test Model' }] : []);
    assert.equal(result.analysisVerified, false);
    assert.equal(result.verification, 'auth_and_model_metadata_only');
    assert.equal(result.usage.inputTokens, null);
    assert.equal(result.usage.estimatedCost, null);
    assert.equal(result.usage.currency, 'USD');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|TOKEN|multiplier/);
    assert.equal(calls.includes('models'), authenticated);
    assert.equal(calls.includes('create'), false);
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'market'), false);
    deleted(state);
    await service.close();
  }
});

test('SDK 1.0.13 explicit isolation, discovery blockers, tool deny and system append contract', async () => {
  const { service, state } = mock();
  await service.analyze(params());
  assert.equal(state.options.mode, 'empty');
  assert.deepEqual(state.options.connection, { kind: 'stdio' });
  assert.equal(state.options.useLoggedInUser, true);
  assert.equal(state.options.logLevel, 'none');
  assert.notEqual(state.options.workingDirectory, ROOT);
  assert.equal(state.options.env.COPILOT_OTEL_ENABLED, 'false');
  for (const key of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'COPILOT_HOME', 'COPILOT_CLI_PATH']) {
    assert.equal(Object.hasOwn(state.options.env, key), false);
  }
  const config = state.config;
  for (const key of ['enableConfigDiscovery', 'enableOnDemandInstructionDiscovery', 'enableFileHooks',
    'enableHostGitOperations', 'enableSessionStore', 'enableSkills', 'enableSessionTelemetry',
    'enableExperimentalMode', 'enableMcpApps', 'requestExtensions', 'requestCanvasRenderer']) assert.equal(config[key], false);
  for (const key of ['availableTools', 'tools', 'skillDirectories', 'instructionDirectories',
    'pluginDirectories', 'additionalDirectories', 'includedBuiltinSkills', 'customAgents']) assert.deepEqual(config[key], []);
  assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*', 'custom:*']);
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.memory, { enabled: false });
  assert.deepEqual(config.infiniteSessions, { enabled: false });
  assert.equal(config.skipCustomInstructions, true);
  assert.equal(config.skipEmbeddingRetrieval, true);
  assert.equal(config.remoteSession, 'off');
  assert.deepEqual(config.onPermissionRequest({ kind: 'shell' }), { kind: 'reject' });
  assert.equal(config.systemMessage.mode, 'append');
  assert.match(config.systemMessage.content, /same language/);
  assert.match(config.systemMessage.content, /follow-up research plan/);
  deleted(state);
  await service.close();
});

test('fresh shared market.show, selected prefix and aligned technicals only, immutable identity', async () => {
  const { service, state, calls } = mock();
  const result = await service.analyze(params());
  assert.deepEqual(calls[0], ['market', 'market.show', { store: path.join(ROOT, '.itt/market') }]);
  const prompt = JSON.parse(state.prompt);
  assert.equal(prompt.question, params().question.trim());
  assert.deepEqual(prompt.context.bars.map(bar => bar.timestamp), [101, 102]);
  assert.deepEqual(prompt.context.technicals.sma20, [null, '11']);
  assert.doesNotMatch(state.prompt, /999999|FUTURE|OTHER_SYMBOL|SPY|SECRET|PRIVATE|SUMMARY|do-not-send|request_urls/);
  assert.equal(result.contextIdentity.barCount, 2);
  assert.equal(result.contextIdentity.rawSha256, 'a'.repeat(64));
  assert.match(result.contextIdentity.contextSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.scope, 'saved_snapshot_only');
  assert.equal(typeof result.answer, 'string');
  await service.analyze(params());
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'market').length, 2);
  const changed = snapshot();
  changed.symbols[0].bars[2].close = '123456789';
  assert.deepEqual(buildSnapshotContext(changed, params()), buildSnapshotContext(snapshot(), params()));
  await service.close();
});

test('full 251-bar selected prefix is retained rather than the UI display window', () => {
  const value = snapshot();
  value.symbols[0].bars = Array.from({ length: 251 }, (_, i) => ({
    timestamp: i + 1, date: '2026-01-01', open: '10', high: '12', low: '9', close: '11', volume: '1',
  }));
  for (const key of ['sma20', 'sma50', 'rsi14']) value.symbols[0].technicals[key] = Array(251).fill(null);
  const result = buildSnapshotContext(value, { ...params(), timestamp: 251 });
  assert.equal(result.context.bars.length, 251);
  assert.equal(result.context.technicals.sma20.length, 251);
});

test('expanded context projects all 27 series and definitions, selected prefix only, with local semantics', () => {
  const value = expandedSnapshot();
  const original = structuredClone(value);
  const result = buildSnapshotContext(value, params());
  const technicals = result.context.technicals;
  assert.equal(SERIES_KEYS.length, 27);
  assert.deepEqual(Object.keys(technicals.series), SERIES_KEYS);
  assert.deepEqual(Object.keys(technicals.definitions), SERIES_KEYS);
  for (const [i, key] of SERIES_KEYS.entries()) {
    assert.deepEqual(technicals.series[key], [null, String(i)]);
    assert.equal(technicals.definitions[key], value.symbols[0].technicals.definitions[key]);
    assert.notEqual(technicals.series[key], value.symbols[0].technicals.series[key]);
  }
  assert.deepEqual(technicals.sma20, [null, '11']);
  assert.deepEqual(technicals.sma50, [null, null]);
  assert.deepEqual(technicals.rsi14, [null, '50']);
  assert.match(technicals.semantics, /own local formulas; no Investing.com parity guaranteed/);
  assert.match(technicals.semantics, /Warmups and undefined ratios are null/);
  assert.match(technicals.definitions.highs_lows14, /C-\(highestH14\+lowestL14\)\/2/);
  assert.doesNotMatch(JSON.stringify(result.context), /987654321|999999|FUTURE|SECRET|PRIVATE/);
  assert.deepEqual(value, original);
  for (const key of SERIES_KEYS) value.symbols[0].technicals.series[key][2] = '123456789';
  value.symbols[0].bars[2].close = '123456789';
  assert.deepEqual(buildSnapshotContext(value, params()), result);
  // A future observation must not even be read while building this prefix.
  for (const key of SERIES_KEYS) Object.defineProperty(value.symbols[0].technicals.series[key], 2, {
    get() { throw new Error('future indicator read'); },
  });
  assert.deepEqual(buildSnapshotContext(value, params()), result);
  value.symbols[0].technicals.series.roc12[1] = '-1.25e+2';
  assert.notEqual(buildSnapshotContext(value, params()).identity.contextSha256, result.identity.contextSha256);
});

test('expanded context ignores unapproved series, definitions and source semantics', () => {
  const value = expandedSnapshot();
  const expected = buildSnapshotContext(value, params());
  for (const target of [value.symbols[0].technicals.series, value.symbols[0].technicals.definitions]) {
    target.unapproved = { secret: 'UNAPPROVED_SECRET', future: 'FUTURE' };
    Object.defineProperty(target, 'unapprovedGetter', {
      enumerable: true, get() { throw new Error('unapproved key read'); },
    });
  }
  value.symbols[0].technicals.semantics = 'UNAPPROVED_SECRET';
  assert.deepEqual(buildSnapshotContext(value, params()), expected);
});

test('expanded contract rejects every partial key set and malformed prefix or definition', () => {
  for (const key of SERIES_KEYS) {
    for (const field of ['series', 'definitions']) {
      const value = expandedSnapshot();
      delete value.symbols[0].technicals[field][key];
      assert.throws(() => buildSnapshotContext(value, params()), code('invalid_snapshot'));
    }
  }
  const changes = [
    ...[undefined, null, [], 'invalid', 1].flatMap(bad => [
      technicals => { technicals.series = bad; },
      technicals => { technicals.definitions = bad; },
    ]),
    technicals => { delete technicals.definitions; },
    ...[null, {}, '123', [], [null, '1'], [null, '1', '2', '3']].map(bad =>
      technicals => { technicals.series.atr14 = bad; }),
    ...[undefined, 1, NaN, Infinity, true, {}, [], '', ' ', 'NaN', 'Infinity', '1e9999', '1x'].map(bad =>
      technicals => { technicals.series.atr14[1] = bad; }),
    technicals => { delete technicals.series.atr14[1]; },
    ...[undefined, null, 1, {}, [], '', ' \n\t ', 'x'.repeat(1025)].map(bad =>
      technicals => { technicals.definitions.atr14 = bad; }),
    technicals => { technicals.series = Object.create(technicals.series); },
    technicals => { technicals.definitions = Object.create(technicals.definitions); },
  ];
  for (const change of changes) {
    const value = expandedSnapshot();
    change(value.symbols[0].technicals);
    assert.throws(() => buildSnapshotContext(value, params()), code('invalid_snapshot'));
  }
});

test('expanded context accepts numeric strings/null and bounded definitions; legacy needs no series', () => {
  for (const numeric of [null, '0', '-12.5', '1e-8', '-2E+3']) {
    const value = expandedSnapshot();
    value.symbols[0].technicals.series.atr14[1] = numeric;
    value.symbols[0].technicals.definitions.atr14 = 'x'.repeat(1024);
    const result = buildSnapshotContext(value, params());
    assert.equal(result.context.technicals.series.atr14[1], numeric);
    assert.equal(result.context.technicals.definitions.atr14.length, 1024);
  }
  const value = snapshot();
  value.symbols[0].technicals.definitions = { unapproved: 'DO_NOT_SEND' };
  const { context } = buildSnapshotContext(value, params());
  assert.deepEqual(context.technicals.sma20, [null, '11']);
  assert.deepEqual(context.technicals.sma50, [null, null]);
  assert.deepEqual(context.technicals.rsi14, [null, '50']);
  assert.equal(Object.hasOwn(context.technicals, 'series'), false);
  assert.equal(Object.hasOwn(context.technicals, 'definitions'), false);
  assert.match(context.technicals.semantics, /no Investing.com parity guaranteed/);
  assert.doesNotMatch(JSON.stringify(context), /DO_NOT_SEND/);
});

test('stale archive, absent selection and bad alignment fail before SDK creation', async () => {
  for (const [change, expected] of [
    [value => { value.manifest.id = '88888888-8888-4888-8888-888888888888'; }, 'archive_mismatch'],
    [value => { value.symbols = []; }, 'selection_missing'],
    [value => { value.symbols[0].bars[1].timestamp = 104; }, 'selection_missing'],
    [value => { value.symbols[0].technicals.sma20 = []; }, 'invalid_snapshot'],
  ]) {
    const { service, calls } = mock({ market: () => { const value = snapshot(); change(value); return value; } });
    await assert.rejects(service.analyze(params()), code(expected));
    await assert.rejects(service.criteria(params()), code(expected));
    assert.equal(calls.includes('factory'), false);
    await service.close();
  }
});

test('provider-only usage is deduplicated by event ID; missing fields remain null', async () => {
  const event = { type: 'assistant.usage', id: 'usage-1', data: { inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cost: 100, copilotUsage: { opaque: 'PRIVATE' } } };
  const { service } = mock({ events: [event, event, { type: 'assistant.message', id: 'fake', data: { inputTokens: 999 } },
    { type: 'assistant.usage', id: 'usage-2', data: { inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 7 } }] });
  const { usage } = await service.analyze(params());
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: null, cacheReadTokens: 3, cacheWriteTokens: null,
    estimatedCost: null, currency: 'USD', source: 'assistant.usage', eventCount: 2 });
  const status = await service.status();
  assert.deepEqual(status.usage, usage);
  await service.close();
});

test('without usage events tokens are unknown, not zero', async () => {
  const { service } = mock();
  const { usage } = await service.analyze(params());
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) assert.equal(usage[key], null);
  assert.equal(usage.eventCount, 0);
  await service.close();
});

test('empty answers and raw SDK failures sanitized, abort/disconnect/delete owned session, stop', async () => {
  for (const options of [{ answer: '   ' }, { answer: null }, { fail: 'send' }, { fail: 'create' },
    { events: [{ type: 'session.error', data: { message: 'TOKEN=DO_NOT_LEAK' } }] }]) {
    const { service, state, calls } = mock(options);
    await assert.rejects(service.analyze(params()), code(Object.hasOwn(options, 'answer') ? 'empty_response' : 'analysis_failed'));
    if (options.fail !== 'create') {
      assert.ok(calls.includes('abort'));
      assert.ok(calls.includes('disconnect'));
    }
    assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'delete'), ['delete', state.config.sessionId]);
    assert.ok(calls.includes('stop'));
    deleted(state);
    await service.close();
  }
  assert.deepEqual(copilotError(Object.assign(new Error('SECRET'), { code: 'SECRET_CODE' })),
    { code: 'unavailable', message: 'GitHub Copilot is unavailable.' });
});

test('session.error rejects a hanging send immediately and cleans resources', async () => {
  const { service, calls } = mock({ send: state => {
    state.config.onEvent({ type: 'session.error', data: { message: 'SECRET' } });
    return new Promise(() => {});
  } });
  await assert.rejects(service.analyze(params()), code('analysis_failed'));
  assert.ok(calls.includes('abort'));
  await service.close();
});

test('auth/model errors unavailable; model mismatch has no send; stop error array is handled', async () => {
  for (const fail of ['start', 'auth', 'models', 'stop']) {
    const { service, state, calls } = mock({ fail });
    const result = await service.status();
    assert.equal(result.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK|SDK_SECRET/);
    assert.ok(calls.includes('stop'));
    deleted(state);
    await service.close();
  }
  const unauthorized = mock({ authenticated: false });
  await assert.rejects(unauthorized.service.analyze(params()), code('not_authenticated'));
  assert.equal(unauthorized.calls.includes('create'), false);
  await unauthorized.service.close();
  const mismatch = mock();
  await assert.rejects(mismatch.service.analyze({ ...params(), model: 'absent' }), code('model_unavailable'));
  assert.equal(mismatch.calls.includes('send'), false);
  await mismatch.service.close();
  const stopped = mock({ stopErrors: [new Error('DO_NOT_LEAK')] });
  await assert.rejects(stopped.service.analyze(params()), code('cleanup_failed'));
  assert.ok(stopped.calls.includes('forceStop'));
  deleted(stopped.state);
  await stopped.service.close();
});

test('pending analysis rejects concurrent status/analyze; close cancels and waits for cleanup', async () => {
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const { service, state, calls } = mock({ send: () => { started(); return new Promise(() => {}); } });
  const pending = service.analyze(params());
  const rejected = assert.rejects(pending, code('closed'));
  await sending;
  await assert.rejects(service.status(), code('busy'));
  await assert.rejects(service.analyze(params()), code('busy'));
  await service.close();
  await rejected;
  assert.ok(calls.includes('abort'));
  deleted(state);
  await service.close();
});

test('pending metadata also blocks analysis without reading market; close cancels metadata', async () => {
  let started;
  const checking = new Promise(resolve => { started = resolve; });
  const { service, state, calls } = mock({ auth: () => { started(); return new Promise(() => {}); } });
  const result = service.status();
  const rejected = assert.rejects(result, code('closed'));
  await checking;
  await assert.rejects(service.status(), code('busy'));
  await assert.rejects(service.analyze(params()), code('busy'));
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'market'), false);
  await service.close();
  await rejected;
  deleted(state);
});

test('explicit transport timeout aborts the session without treating it as a usage budget', async t => {
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const { service, state, calls } = mock({ send: () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    started();
    return new Promise(() => {});
  } });
  const pending = service.analyze(params());
  const rejected = assert.rejects(pending, code('transport_timeout'));
  await sending;
  t.mock.timers.tick(TRANSPORT_TIMEOUT_MS);
  await rejected;
  assert.ok(calls.includes('abort'));
  deleted(state);
  await service.close();
  t.mock.timers.reset();
});

test('disconnect/delete cleanup failures are sanitized and still stop and remove owned temp', async () => {
  for (const fail of ['disconnect', 'delete']) {
    const { service, state, calls } = mock({ fail });
    await assert.rejects(service.analyze(params()), code('cleanup_failed'));
    assert.ok(calls.includes('stop'));
    deleted(state);
    await service.close();
  }
});

const args = () => ['analyze', '--symbol', 'QQQ', '--timestamp', '102', '--archive-id', ARCHIVE,
  '--model', 'test-model', '--question', '日本語の質問'];
test('CLI strict parser rejects unknown/duplicate/missing args and preserves question semantics', () => {
  assert.deepEqual(parseCopilotArgs(['status']), { method: 'copilot.status', params: {} });
  assert.equal(parseCopilotArgs(args()).params.question, '日本語の質問');
  for (const command of ['analyze', 'criteria']) {
    const values = [command, ...args().slice(1)];
    assert.equal(parseCopilotArgs(values).method, `copilot.${command}`);
    assert.equal(Object.hasOwn(parseCopilotArgs(values).params, 'consent'), false);
    assert.equal(parseCopilotArgs([...values, '--consent']).params.consent, true);
    assert.throws(() => parseCopilotArgs([...values, '--consent', '--consent']));
    assert.throws(() => parseCopilotArgs([...values, '--store', '/private']));
  }
  for (const values of [[], ['status', '--consent'], ['unknown'], [...args(), '--extra'],
    [...args(), '--symbol', 'SPY'], args().slice(0, -1), [...args(), '--consent', '--consent'],
    args().map(value => value === '102' ? '102.5' : value), args().map(value => value === '102' ? '1e2' : value)]) {
    assert.throws(() => parseCopilotArgs(values));
  }
});

test('CLI validation exit 2 does not construct services; metadata avoids Python; runtime exit 1 sanitized', async () => {
  const lines = [];
  let constructed = 0;
  const dependencies = { write: line => lines.push(line), backendFactory: () => { constructed++; throw new Error('SECRET'); },
    serviceFactory: () => { constructed++; throw new Error('SECRET'); } };
  assert.equal(await runCopilotCLI(['invalid'], dependencies), 2);
  assert.equal(constructed, 0);
  assert.equal(JSON.parse(lines.pop()).ok, false);
  assert.equal(await runCopilotCLI(['status'], dependencies), 1);
  assert.equal(constructed, 1);
  assert.doesNotMatch(lines.pop(), /SECRET/);
  const closed = [];
  assert.equal(await runCopilotCLI(['status'], { ...dependencies,
    serviceFactory: () => ({ status: async () => ({ status: 'ready' }), close: async () => closed.push('copilot') }),
  }), 0);
  assert.equal(constructed, 1);
  assert.deepEqual(closed, ['copilot']);
  assert.equal(await runCopilotCLI(args(), { write: line => lines.push(line),
    backendFactory: () => ({ request: async () => ({}), close: async () => closed.push('backend') }),
    serviceFactory: ({ backend }) => ({ analyze: async () => backend.request('market.show', {}),
      close: async () => closed.push('copilot') }),
  }), 0);
  assert.deepEqual(closed.slice(-2), ['copilot', 'backend']);
  assert.equal(JSON.parse(lines.pop()).ok, true);
});

test('default service accepts explicit analysis with omitted or legacy true consent', async () => {
  const { service, calls, state } = mock();
  assert.deepEqual(calls, []);
  for (const request of [params(), { ...params(), consent: true }]) {
    const result = await service.analyze(request);
    assert.equal(result.provider, 'github_copilot');
    assert.equal(result.model, 'test-model');
    assert.equal(typeof result.answer, 'string');
    assert.doesNotMatch(state.prompt, /consent|test-account|github\.com|authType|DO_NOT_LEAK/);
    deleted(state);
  }
  assert.equal(calls.filter(call => call === 'send').length, 2);
  await service.close();
});

test('status redacts unsafe identity fields, raw credentials and unknown auth metadata', async () => {
  for (const unsafe of ['<img src=x onerror=alert(1)>', 'C:\\private\\account', 'TOKEN=DO_NOT_LEAK',
    'ghp_DO_NOT_LEAK', 'github_pat_DO_NOT_LEAK', 'sk-DO_NOT_LEAK', 'Bearer:DO_NOT_LEAK',
    'test-account\n', 'x'.repeat(254), {}, null]) {
    const { service } = mock({ auth: () => ({ isAuthenticated: true,
      login: unsafe, host: unsafe, authType: unsafe, accessToken: 'DO_NOT_LEAK',
      nested: { token: 'DO_NOT_LEAK' }, statusMessage: 'DO_NOT_LEAK' }) });
    const result = await service.status();
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.identity, { login: null, host: null, authType: null });
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK|accessToken|statusMessage|nested/);
    await service.close();
  }
  const { service } = mock({ fail: 'models' });
  const status = await service.status();
  assert.equal(status.status, 'unavailable');
  assert.deepEqual(status.identity, { login: 'test-account', host: 'github.com', authType: 'user' });
  await service.close();
});

test('optional auth-only diagnostic blocks both inference methods without enterprise gating', async () => {
  const calls = [];
  const service = buildCopilotService({ authOnly: true, clientFactory: async () => ({
    async start() { calls.push('start'); },
    async getAuthStatus() { calls.push('auth'); return { isAuthenticated: true, login: 'test-account', host: 'github.com', authType: 'user' }; },
    async listModels() { assert.fail('diagnostic must not load models'); },
    async createSession() { assert.fail('diagnostic must not infer'); },
    async stop() { calls.push('stop'); return []; },
  }) });
  await assert.rejects(service.analyze(params()), code('analysis_disabled'));
  await assert.rejects(service.criteria(params()), code('analysis_disabled'));
  assert.deepEqual(calls, []);
  const status = await service.status();
  assert.equal(status.status, 'connected');
  assert.equal(status.verification, 'auth_metadata_only');
  assert.equal(status.analysisAllowed, false);
  assert.equal(status.analysisBlock, 'analysis_disabled');
  assert.deepEqual(status.models, []);
  assert.deepEqual(calls, ['start', 'auth', 'stop']);
  await service.close();
});

const proposal = () => ({
  entry: { left: 'sma20', op: 'crosses_above', right: 'sma50' },
  exit: { left: 'rsi14', op: 'lt', right: '30' },
  explanation: '진입은 SMA20 상향 교차, 청산은 RSI14 30 미만이다. 백테스트하지 않은 검토용 조건이다.',
});

test('criteria uses semantic JSON-only prompt, same curated source, identity, isolation and cleanup', async () => {
  const expected = proposal();
  const { service, state, calls } = mock({ answer: JSON.stringify(expected), market: expandedSnapshot,
    events: [{ type: 'assistant.usage', id: 'criteria-1', data: { inputTokens: 8, outputTokens: 12 } }] });
  const question = '20일 단순이동평균이 50일선을 위로 통과하면 진입하고 RSI14가 30 미만이면 청산';
  const result = await service.criteria({ ...params(), question });
  assert.deepEqual(result.criteria, { entry: expected.entry, exit: expected.exit });
  assert.equal(result.explanation, expected.explanation);
  assert.equal(result.provider, 'github_copilot');
  assert.equal(result.model, 'test-model');
  assert.equal(result.archiveId, ARCHIVE);
  assert.equal(result.symbol, 'QQQ');
  assert.equal(result.timestamp, 102);
  assert.equal(Object.hasOwn(result, 'answer'), false);
  assert.equal(result.usage.inputTokens, 8);
  assert.equal(result.usage.outputTokens, 12);
  assert.equal(result.usage.estimatedCost, null);
  const source = buildSnapshotContext(expandedSnapshot(), params());
  assert.deepEqual(result.contextIdentity, source.identity);
  assert.deepEqual(JSON.parse(state.prompt), { question, context: source.context });
  assert.doesNotMatch(state.prompt, /999999|987654321|FUTURE|OTHER_SYMBOL|SPY|SECRET|PRIVATE|SUMMARY|do-not-send|test-account/);
  assert.match(state.config.systemMessage.content, /semantically/);
  assert.match(state.config.systemMessage.content, /same language/);
  assert.match(state.config.systemMessage.content, /ONLY one JSON object/);
  assert.match(state.config.systemMessage.content, /Do not assume/);
  assert.match(state.config.systemMessage.content, /Do not claim the strategy was tested/);
  assert.deepEqual(state.config.tools, []);
  assert.deepEqual(state.config.onPermissionRequest({ kind: 'shell' }), { kind: 'reject' });
  assert.equal(calls.filter(call => call === 'send').length, 1);
  assert.equal(calls.includes('abort'), false);
  assert.ok(calls.includes('disconnect'));
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'delete'), ['delete', state.config.sessionId]);
  deleted(state);
  await service.close();
});

test('criteria operand/operator allowlists stay aligned with Python and preserve decimal strings', async () => {
  // Read the authoritative contract as text; never import or execute Python.
  const python = readFileSync(new URL('../../src/itt/criteria.py', import.meta.url), 'utf8');
  const operands = [...python.match(/Operand = Literal\[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const operators = [...python.match(/op: Literal\[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(new Set(operands), new Set(['open', 'high', 'low', 'close', 'rsi14', ...SERIES_KEYS]));
  assert.deepEqual(operators, ['gt', 'lt', 'gte', 'lte', 'eq', 'crosses_above', 'crosses_below']);
  let current;
  const { service, state } = mock({ send: () => ({ data: { content: JSON.stringify(current) } }) });
  for (const operand of operands) {
    current = { ...proposal(), entry: { left: operand, op: 'gt', right: operand } };
    assert.deepEqual((await service.criteria(params())).criteria.entry, current.entry);
  }
  for (const [index, numeric] of ['0', '-12.5', '+.5', '1.', '-2E+3', '1e-8', '1e100', '9007199254740993.125'].entries()) {
    current = { ...proposal(), exit: { left: 'close', op: operators[index % operators.length], right: numeric } };
    const result = await service.criteria({ ...params(), consent: true });
    assert.deepEqual(result.criteria.exit, current.exit);
  }
  for (const operand of operands) assert.ok(state.config.systemMessage.content.includes(`"${operand}"`));
  deleted(state);
  await service.close();
});

test('criteria rejects unsupported, malformed and malicious output with sanitized errors and no retry', async () => {
  const badRules = [
    { left: 'volume', op: 'gt', right: '30' },
    { left: 'sma21', op: 'gt', right: 'close' },
    { left: '30', op: 'gt', right: 'close' },
    { left: 'constructor', op: 'gt', right: 'close' },
    { left: 'close', op: 'ge', right: '30' },
    { left: 'close', op: 'gt', right: 'volume' },
    { left: 'close', op: 'gt', right: true },
    { left: 'close', op: 'gt', right: 'NaN' },
    { left: 'close', op: 'gt', right: 'Infinity' },
    { left: 'close', op: 'gt', right: ' 30' },
    { left: 'close', op: 'gt', right: '30\n' },
    { left: 'close', op: 'gt', right: 'close * 1.05' },
    { left: 'close', op: 'gt', right: 'process.exit(1)' },
    { left: 'close', op: 'gt', right: '__proto__' },
    { left: 'close', op: 'gt', right: '30', code: 'TOKEN=DO_NOT_LEAK' },
    { left: 'close', op: 'gt' }, null, [],
  ];
  const invalid = [
    'TOKEN=DO_NOT_LEAK', '```json\n' + JSON.stringify(proposal()) + '\n```',
    JSON.stringify(proposal()) + ' trailing code',
    JSON.stringify({ ...proposal(), __extra: 'TOKEN=DO_NOT_LEAK' }),
    JSON.stringify({ ...proposal(), unsupported: 'TOKEN=DO_NOT_LEAK' }),
    '{"__proto__":{"polluted":"TOKEN=DO_NOT_LEAK"}}',
    ...[null, [], {}, { unsupported: '' }, { unsupported: 1 },
      { entry: proposal().entry, exit: proposal().exit },
      { ...proposal(), explanation: '' }, { ...proposal(), explanation: {} }].map(value => JSON.stringify(value)),
    ...badRules.flatMap(rule => ['entry', 'exit'].map(key => JSON.stringify({ ...proposal(), [key]: rule }))),
  ];
  for (const [answer, expected] of [...invalid.map(value => [value, 'invalid_criteria']),
    [JSON.stringify({ unsupported: 'TOKEN=DO_NOT_LEAK /private/account' }), 'criteria_unsupported']]) {
    const { service, state, calls } = mock({ answer });
    await assert.rejects(service.criteria(params()), code(expected));
    assert.equal(calls.filter(call => call === 'send').length, 1);
    assert.ok(calls.includes('abort'));
    assert.ok(calls.includes('disconnect'));
    assert.ok(calls.includes('stop'));
    assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'delete'), ['delete', state.config.sessionId]);
    deleted(state);
    await service.close();
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('criteria rejects unavailable auth/models and sanitizes SDK and cleanup failures', async () => {
  for (const [options, request, expected] of [
    [{ authenticated: false }, params(), 'not_authenticated'],
    [{}, { ...params(), model: 'absent' }, 'model_unavailable'],
    [{ fail: 'send' }, params(), 'analysis_failed'],
    [{ answer: ' ' }, params(), 'empty_response'],
    [{ answer: JSON.stringify(proposal()), fail: 'disconnect' }, params(), 'cleanup_failed'],
  ]) {
    const { service, state, calls } = mock(options);
    await assert.rejects(service.criteria(request), code(expected));
    if (['not_authenticated', 'model_unavailable'].includes(expected)) assert.equal(calls.includes('send'), false);
    deleted(state);
    await service.close();
  }
});

test('pending criteria blocks status and inference; close aborts and cleans owned resources', async () => {
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const { service, state, calls } = mock({ send: () => { started(); return new Promise(() => {}); } });
  const rejected = assert.rejects(service.criteria(params()), code('closed'));
  await sending;
  await assert.rejects(service.status(), code('busy'));
  await assert.rejects(service.analyze(params()), code('busy'));
  await assert.rejects(service.criteria(params()), code('busy'));
  await service.close();
  await rejected;
  assert.ok(calls.includes('abort'));
  deleted(state);
  await assert.rejects(service.criteria(params()), code('closed'));
});

test('CLI criteria routes without mandatory consent and closes both resources', async () => {
  const calls = [], lines = [];
  const values = ['criteria', ...args().slice(1)];
  const expected = { criteria: { entry: proposal().entry, exit: proposal().exit }, explanation: proposal().explanation };
  assert.equal(await runCopilotCLI(values, {
    write: line => lines.push(line),
    backendFactory: () => ({ async request(method) { calls.push(method); }, async close() { calls.push('backend.close'); } }),
    serviceFactory: ({ backend }) => ({
      async criteria(request) {
        assert.deepEqual(request, parseCopilotArgs(values).params);
        calls.push('criteria');
        await backend.request('market.show');
        return expected;
      },
      async analyze() { assert.fail('must not route criteria to analyze'); },
      async close() { calls.push('copilot.close'); },
    }),
  }), 0);
  assert.deepEqual(calls, ['criteria', 'market.show', 'copilot.close', 'backend.close']);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ok: true, result: expected });
});

test('compound custom-period proposals preserve expressions and semantic instructions', async () => {
  const entry = { all: [
    { left: { indicator: 'sma', period: 21 }, op: 'crosses_above', right: { indicator: 'ema', period: 63, lag: 1 } },
    { any: [
      { left: { field: 'volume' }, op: 'gte', right: 1000 },
      { not: { left: { operation: 'divide', left: 'close', right: { field: 'close', lag: 5 } }, op: 'lt', right: '1.05' } },
    ] },
  ] };
  const exit = { left: { indicator: 'volatility', period: 20 }, op: 'gt', right: '.04' };
  const { service, state } = mock({ answer: JSON.stringify({ entry, exit, explanation: 'Review-only compound conditions.' }) });
  const result = await service.criteria(params());
  assert.deepEqual(result.criteria, { entry, exit });
  assert.match(state.config.systemMessage.content, /population standard deviation/);
  assert.match(state.config.systemMessage.content, /any unavailable descendant/);
  assert.match(state.config.systemMessage.content, /neither true means hold/);
  assert.match(state.config.systemMessage.content, /Cost counts nodes/);
  await service.close();
});

test('shared JS validator matches Python on JSON expressions and resource boundaries', () => {
  const leaf = { left: 'close', op: 'gt', right: 0 };
  const cases = [leaf, proposal().entry, { all: [leaf] }, { any: [leaf] }, { not: leaf }];
  for (const indicator of ['sma', 'ema', 'rsi', 'roc', 'return', 'volatility', 'unknown']) {
    for (const period of [1, 21, 252, 0, 253, 1.5, true, '2', null]) {
      cases.push({ ...leaf, left: { indicator, period } });
    }
  }
  for (const lag of [0, 252, -1, 253, true, '1', null]) cases.push({ ...leaf, left: { field: 'volume', lag } });
  for (const operation of ['add', 'subtract', 'multiply', 'divide', 'power']) {
    cases.push({ ...leaf, left: { operation, left: 'close', right: '2' } });
  }
  for (const right of ['1e100', '1e-100', '1e101', '1e-101', '1'.repeat(64), '1'.repeat(65),
    '+.5', '1.', 'NaN', '1\n', true, null, [], {}, 1.5, 1e101]) cases.push({ ...leaf, right });
  let nested = leaf;
  for (let i = 0; i < 20; i++) { nested = { not: nested }; cases.push(nested); }
  const expensive = { ...leaf, left: { indicator: 'sma', period: 252 }, op: 'crosses_above' };
  cases.push({ all: [] }, { any: [] }, { all: Array(33).fill(leaf) }, { all: Array(8).fill(expensive) },
    { all: Array(9).fill(expensive) }, { all: [{ any: Array(32).fill(leaf) }, { any: Array(32).fill(leaf) }] },
    { ...leaf, extra: 1 }, { not: leaf, all: [leaf] });
  const interpreter = process.env.ITT_PYTHON || path.join(ROOT, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const source = [
    'import json, sys', 'from pydantic import ValidationError',
    'from itt.criteria import Criterion', 'results = []',
    'for value in json.load(sys.stdin):',
    '    try:', '        Criterion.model_validate(value)',
    '    except ValidationError:', '        results.append(False)',
    '    else:', '        results.append(True)', 'print(json.dumps(results))',
  ].join('\n');
  const python = spawnSync(interpreter, ['-c', source], {
    input: JSON.stringify(cases), encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') }, timeout: 30000,
  });
  assert.equal(python.status, 0, python.stderr || String(python.error));
  const expected = JSON.parse(python.stdout);
  cases.forEach((value, i) => assert.equal(criterion(value), expected[i], JSON.stringify(value)));
  assert.deepEqual(CRITERIA_LIMITS, { depth: 12, nodes: 128, children: 32, cost: 4096 });
  const cycle = {}; cycle.not = cycle;
  assert.equal(criterion(cycle), false);
  assert.equal(criterion({ all: Array(2) }), false);
  for (const right of [Infinity, NaN, undefined]) assert.equal(criterion({ ...leaf, right }), false);
});

test('generalized symbols retain exact selected identity in mocked analysis and criteria', async () => {
  for (const symbol of ['AAPL', 'BRK.B', 'BRK-B', 'A123456789']) {
    const request = { ...params(), symbol };
    for (const method of ['copilot.analyze', 'copilot.criteria']) {
      assert.equal(validateCopilotRequest(method, request).params.symbol, symbol);
    }
    const market = () => {
      const value = snapshot();
      value.symbols[0].symbol = symbol;
      value.manifest.raw_sha256[`raw-${symbol}.json`] = 'c'.repeat(64);
      return value;
    };
    const { service, state, calls } = mock({ market, answer: JSON.stringify(proposal()) });
    try {
      for (const method of ['analyze', 'criteria']) {
        const result = await service[method](request);
        assert.equal(result.symbol, symbol);
        assert.equal(result.contextIdentity.symbol, symbol);
        assert.equal(result.contextIdentity.rawSha256, 'c'.repeat(64));
        assert.equal(JSON.parse(state.prompt).context.symbol, symbol);
      }
      assert.equal(calls.filter(call => call === 'send').length, 2);
      assert.ok(calls.filter(call => Array.isArray(call) && call[0] === 'market')
        .every(call => call[1] === 'market.show'), 'no fetch, symbol substitution or auto-backtest');
    } finally { await service.close(); }
  }
  for (const symbol of ['../AAPL', 'AAPL/..', 'aapl', 'A1234567890', '1AAPL', '', true]) {
    assert.throws(() => validateCopilotRequest('copilot.analyze', { ...params(), symbol }), code('invalid_request'));
  }
});