import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedJSONExport, MAX_JSON_EXPORT_BYTES, allowedNavigation, desktopCopilot, desktopWebPreferences } from '../../ui/desktop-policy.js';

test('JSON exports require native gesture, current owned contents and bounded exact blob metadata', () => {
  const origin = 'http://127.0.0.1:45678';
  const url = `blob:${origin}/12345678-abcd-4abc-8abc-123456789abc`;
  const good = { origin, url, urlChain: [url], filename: 'itt-correlation.json',
    mime: 'application/json', bytes: 2, userGesture: true, ownedContents: true, currentURL: `${origin}/` };
  assert.equal(allowedJSONExport(good), true);
  for (const filename of ['itt-correlation.json', 'itt-trigger.json', 'itt-backtest.json', 'itt-portfolio.json']) {
    for (const mime of ['application/json', 'text/json']) {
      assert.equal(allowedJSONExport({ ...good, filename, mime, bytes: MAX_JSON_EXPORT_BYTES }), true);
    }
  }
  const invalid = [
    { userGesture: false }, { userGesture: 1 }, { ownedContents: false },
    { currentURL: `${origin}/api` }, { currentURL: 'https://example.com/' },
    { bytes: 0 }, { bytes: -1 }, { bytes: NaN }, { bytes: Infinity }, { bytes: 1.1 },
    { bytes: '2' }, { bytes: MAX_JSON_EXPORT_BYTES + 1 },
    { mime: 'text/html' }, { mime: 'application/octet-stream' }, { mime: 'application/json;charset=utf-8' },
    ...['result.json', 'itt-correlation.json.exe', '../itt-correlation.json', 'ITT-correlation.json',
      'itt-correlation.json:stream', 'itt-correlation.json '].map(filename => ({ filename })),
    { urlChain: [] }, { urlChain: [url, url] }, { urlChain: ['https://example.com/file'] },
    { origin: 'https://example.com' }, { origin: `${origin}/` },
    ...['https://example.com/result.json', `${origin}/result.json`, 'file:///C:/file.json',
      'data:application/json,{}', `blob:${origin}/not-a-uuid`, `blob:${origin}/12345678-ABCD-4abc-8abc-123456789abc`,
      `${url}?q=1`, `${url}#fragment`, `${url}/extra`, url.replace(':45678', ':45679'),
      url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', 'user@127.0.0.1')]
      .map(value => ({ url: value, urlChain: [value] })),
  ];
  for (const change of invalid) assert.equal(allowedJSONExport({ ...good, ...change }), false, JSON.stringify(change));
});

test('export allowlist matches actual UI JSON names and production retains native save prompt', () => {
  const research = readFileSync(new URL('../../ui/gui/research.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../ui/gui/app.js', import.meta.url), 'utf8');
  assert.match(research, /download\(correlationResult, 'correlation'\)/);
  assert.match(research, /download\(triggerResult, 'trigger'\)/);
  assert.match(app, /\? 'portfolio' : 'backtest'/);
  const desktop = readFileSync(new URL('../../ui/desktop.js', import.meta.url), 'utf8');
  assert.match(desktop, /item\.hasUserGesture\(\)/);
  assert.match(desktop, /contents === window\.webContents/);
  assert.match(desktop, /item\.setSaveDialogOptions\(/);
  assert.doesNotMatch(desktop, /item\.setSavePath\(|item\.savePath\s*=/);
});

test('desktop renderer isolation and navigation restrictions', () => {
  assert.equal(desktopWebPreferences.sandbox, true);
  assert.equal(desktopWebPreferences.contextIsolation, true);
  assert.equal(desktopWebPreferences.nodeIntegration, false);
  assert.equal(desktopWebPreferences.webSecurity, true);
  const origin = 'http://127.0.0.1:45678';
  assert.equal(allowedNavigation(`${origin}/#main`, origin), true);
  for (const target of ['https://github.com', `${origin}/api`, `${origin}.evil.test/`,
    'file:///C:/Windows', 'javascript:alert(1)', 'http://user@127.0.0.1:45678/']) {
    assert.equal(allowedNavigation(target, origin), false);
  }
});

for (const authenticated of [true, false]) {
  test(`desktop explicit status loads safe identity and models (${authenticated}), never inference`, async () => {
    const calls = [];
    const service = desktopCopilot({ clientFactory: async () => ({
      async start() { calls.push('start'); },
      async getAuthStatus() { calls.push('auth'); return { isAuthenticated: authenticated,
        login: 'test-account', host: 'github.com', authType: 'user', statusMessage: 'SECRET' }; },
      async listModels() { calls.push('models'); return [{ id: 'test-model', name: 'Test Model' }]; },
      async createSession() { throw Error('Must not start inference'); },
      async stop() { calls.push('stop'); return []; },
    }) });
    assert.deepEqual(calls, []);
    await assert.rejects(service.analyze(), { code: 'invalid_request' });
    await assert.rejects(service.criteria(), { code: 'invalid_request' });
    assert.deepEqual(calls, []);
    const result = await service.status();
    assert.equal(result.status, authenticated ? 'ready' : 'not_authenticated');
    assert.equal(result.authenticated, authenticated);
    assert.equal(result.verification, 'auth_and_model_metadata_only');
    assert.equal(result.analysisBlock, undefined);
    assert.deepEqual(result.identity, { login: 'test-account', host: 'github.com', authType: 'user' });
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.deepEqual(result.models, authenticated ? [{ id: 'test-model', name: 'Test Model' }] : []);
    assert.deepEqual(calls, authenticated ? ['start', 'auth', 'models', 'stop'] : ['start', 'auth', 'stop']);
    await service.close();
  });
}

test('desktop allows explicit no-consent analysis and criteria with its supplied backend', async () => {
  const calls = [];
  const archiveId = '77777777-7777-4777-8777-777777777777';
  const request = { symbol: 'QQQ', timestamp: 102, archiveId, model: 'test-model', question: 'Explain these criteria' };
  const expected = { entry: { left: 'close', op: 'gt', right: 'sma20' },
    exit: { left: 'close', op: 'lt', right: 'sma20' }, explanation: 'Untested proposal for review.' };
  const service = desktopCopilot({
    backend: { async request(method) {
      calls.push(method);
      return { manifest: { id: archiveId, provider: 'Yahoo Finance', collected_at: '2026-09-10T00:00:00Z',
        raw_sha256: { 'raw-QQQ.json': 'a'.repeat(64) } },
      symbols: [{ symbol: 'QQQ', currency: 'USD', date_basis: 'exchange_timezone',
        price_basis: 'provider chart close (not total return; split adjustment possible)',
        bars: [{ timestamp: 102, date: '2026-09-01', open: '10', high: '12', low: '9', close: '11', volume: '100' }],
        technicals: { version: '1', basis: 'provider_close', sma20: [null], sma50: [null], rsi14: [null] } }] };
    } },
    clientFactory: async () => ({
      async start() { calls.push('start'); },
      async getAuthStatus() { return { isAuthenticated: true, login: 'test-account' }; },
      async listModels() { return [{ id: 'test-model', name: 'Test Model' }]; },
      async createSession() { return {
        on() { return () => {}; },
        async sendAndWait() { calls.push('send'); return { data: { content: JSON.stringify(expected) } }; },
        async disconnect() { calls.push('disconnect'); },
      }; },
      async deleteSession() { calls.push('delete'); },
      async stop() { calls.push('stop'); return []; },
    }),
  });
  assert.deepEqual(calls, []);
  assert.equal(typeof (await service.analyze(request)).answer, 'string');
  assert.deepEqual((await service.criteria(request)).criteria, { entry: expected.entry, exit: expected.exit });
  assert.equal(calls.filter(call => call === 'market.show').length, 2);
  assert.equal(calls.filter(call => call === 'send').length, 2);
  assert.equal(calls.filter(call => call === 'delete').length, 2);
  assert.equal(calls.filter(call => call === 'stop').length, 2);
  await service.close();
});

test('desktop startup shares backend with Copilot and has no obsolete setup-script instruction', () => {
  const source = readFileSync(new URL('../../ui/desktop.js', import.meta.url), 'utf8');
  assert.match(source, /const backend = createBackend\(\)/);
  assert.match(source, /desktopCopilot\(\{ backend \}\)/);
  assert.match(source, /startGUI\(\{ backend, copilot \}\)/);
  assert.doesNotMatch(source, /blockedDesktopCopilot|run\.ps1/);
  assert.match(source, /developer guide setup instructions/);
});