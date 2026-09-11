import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBackend, ROOT, safeError, safeErrorCode } from './backend.js';
import { buildCopilotService, validateCopilotRequest, copilotError } from './copilot.js';
import { criterion } from './criteria-schema.js';
import { buildGuruService, validateGuruRequest, GuruServiceError } from './guru-service.js';

const symbolValid = value => typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(value);
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
// Bound decimal text AND exponent before Python's exact-rational arithmetic.
// This HTTP transport subset accepts scientific notation without numeric coercion.
const decimal = value => typeof value === 'string' && value.length <= 64
  && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)
  && Math.abs(Number(value.split(/[eE]/)[1] || 0)) <= 100;
const DECIMAL_UNIT = 10n ** 164n;
function decimalUnits(value) {
  const [mantissa, exponent = '0'] = value.split(/[eE]/);
  const fraction = mantissa.split('.')[1]?.length || 0;
  return BigInt(mantissa.replace('.', '')) * 10n ** BigInt(164 + Number(exponent) - fraction);
}
const sessionDate = value => typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
  && value.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// Public GUI boundary: never accept client paths, arbitrary RPC methods or shell commands.
export function guiRequest(method, params = {}, root = ROOT) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params');
  const keys = Object.keys(params);
  const allowed = {
    capabilities: [], 'market.show': [], 'market.fetch': ['symbols', 'start', 'end'],
    'market.backtest': ['spec'], 'market.portfolio': ['spec'],
    'market.correlation': ['spec'], 'market.trigger': ['spec'], 'market.guru': ['spec'],
    'runs.list': [], 'runs.show': ['id'], 'runs.replay': ['id'],
    'decisions.list': ['id'], 'decisions.add': ['id', 'text'],
  };
  if (!Object.hasOwn(allowed, method) || keys.some(key => !allowed[method].includes(key)) ||
      allowed[method].some(key => !(method === 'market.fetch' && ['start', 'end'].includes(key)) && !Object.hasOwn(params, key))) throw new Error('method');
  if (method === 'market.fetch' && ('start' in params || 'end' in params)
      && (!sessionDate(params.start) || !sessionDate(params.end) || params.start > params.end
        || params.end === '9999-12-31')) throw new Error('dates');
  if ('id' in params && (typeof params.id !== 'string' || !/^[0-9a-f-]{36}$/.test(params.id))) throw new Error('id');
  if ('text' in params && (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 2048)) throw new Error('text');
  if ('symbols' in params && (!Array.isArray(params.symbols) || params.symbols.length < 1 || params.symbols.length > 10 ||
      params.symbols.some(symbol => !symbolValid(symbol)) || new Set(params.symbols).size !== params.symbols.length)) throw new Error('symbols');
  if (method === 'market.guru') {
    if (!exact(params.spec, ['filings', 'as_of']) || !sessionDate(params.spec.as_of)
        || !Array.isArray(params.spec.filings) || !params.spec.filings.length || params.spec.filings.length > 1000) throw new Error('spec');
    // Nested filing validation is authoritative in GuruSpec; it performs no network or file access.
    return { method, params: { spec: params.spec } };
  }
  if (method === 'market.correlation' || method === 'market.trigger') {
    const spec = params.spec, correlation = method === 'market.correlation';
    const required = ['archive_id', 'start', 'end', ...(correlation ? ['symbols'] : ['symbol', 'target_symbol', 'condition'])];
    const optional = correlation ? ['frequency'] : ['horizons'];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)
        || required.some(key => !Object.hasOwn(spec, key)) || Object.keys(spec).some(key => ![...required, ...optional].includes(key))
        || typeof spec.archive_id !== 'string' || !spec.archive_id.trim() || spec.archive_id.length > 128
        || !sessionDate(spec.start) || !sessionDate(spec.end) || spec.start >= spec.end) throw new Error('spec');
    if (correlation) {
      if (!Array.isArray(spec.symbols) || spec.symbols.length < 2 || spec.symbols.length > 10
          || spec.symbols.some(symbol => !symbolValid(symbol)) || new Set(spec.symbols).size !== spec.symbols.length
          || ('frequency' in spec && !['daily', 'weekly', 'monthly'].includes(spec.frequency))) throw new Error('spec');
    } else if (!symbolValid(spec.symbol) || !symbolValid(spec.target_symbol) || !criterion(spec.condition)
        || ('horizons' in spec && (!Array.isArray(spec.horizons) || !spec.horizons.length || spec.horizons.length > 60
          || spec.horizons.some(n => !Number.isInteger(n) || n < 1 || n > 60) || new Set(spec.horizons).size !== spec.horizons.length))) throw new Error('spec');
    return { method, params: { store_path: path.join(root, '.itt/market'), spec } };
  }
  if (method === 'market.backtest' || method === 'market.portfolio') {
    // Only bounded declarative values cross this boundary. Python verifies the archive,
    // exact session alignment, criteria and financial accounting; never accept paths.
    const spec = params.spec;
    const portfolio = method === 'market.portfolio';
    const fields = ['archive_id', 'start', 'end', 'initial_cash', 'fee_bps', 'slippage_bps', 'entry', 'exit',
      ...(portfolio ? ['weights', 'rebalance_every'] : ['symbol'])];
    const optional = portfolio ? ['allocation', 'rebalance_calendar'] : [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || fields.some(key => !Object.hasOwn(spec, key))
      || Object.keys(spec).some(key => ![...fields, ...optional].includes(key)) || typeof spec.archive_id !== 'string' || !spec.archive_id.trim()
        || spec.archive_id.length > 128 || !sessionDate(spec.start) || !sessionDate(spec.end) || spec.start >= spec.end
        || !['initial_cash', 'fee_bps', 'slippage_bps'].every(key => decimal(spec[key]))
        || decimalUnits(spec.initial_cash) <= 0n
        || ['fee_bps', 'slippage_bps'].some(key => decimalUnits(spec[key]) < 0n || decimalUnits(spec[key]) >= 10000n * DECIMAL_UNIT)
        || !criterion(spec.entry) || !criterion(spec.exit)) throw new Error('spec');
    if (portfolio) {
      const weights = spec.weights;
      if (!weights || typeof weights !== 'object' || Array.isArray(weights)
          || Object.keys(weights).length < 1 || Object.keys(weights).length > 10
          || Object.entries(weights).some(([symbol, weight]) => !symbolValid(symbol) || !decimal(weight))
          || !Number.isSafeInteger(spec.rebalance_every) || spec.rebalance_every < 1
          || spec.rebalance_every > 100000) throw new Error('spec');
      const units = Object.values(weights).map(decimalUnits), total = units.reduce((sum, weight) => sum + weight, 0n);
      if (units.some(weight => weight < 0n || weight > DECIMAL_UNIT) || total <= 0n || total > DECIMAL_UNIT) throw new Error('spec');
      if ('rebalance_calendar' in spec && !['sessions', 'monthly', 'quarterly'].includes(spec.rebalance_calendar)) throw new Error('spec');
      if ('allocation' in spec) {
        const a = spec.allocation;
        if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(key => !['mode', 'lookback', 'top_n', 'minimum_return'].includes(key))
            || ('mode' in a && !['fixed', 'momentum'].includes(a.mode))
            || ('lookback' in a && (!Number.isInteger(a.lookback) || a.lookback < 1 || a.lookback > 252))
            || ('top_n' in a && (!Number.isInteger(a.top_n) || a.top_n < 1 || a.top_n > Object.keys(weights).length))
            || ('minimum_return' in a && !decimal(a.minimum_return))) throw new Error('spec');
      }
    } else if (!symbolValid(spec.symbol)) throw new Error('spec');
    return { method, params: { store_path: path.join(root, '.itt/market'), spec } };
  }
  const store = method.startsWith('market.') ? path.join(root, '.itt/market') : path.join(root, '.itt/runs');
  return { method, params: method === 'capabilities' ? {} : { ...params, store } };
}

export async function startGUI({ backend = createBackend(), port = 0, root = ROOT, copilot, guru } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  let backendFailed = false;
  let copilotService = copilot;
  let guruService = guru;
  const connections = new Set();
  backend.on?.('failure', () => { backendFailed = true; });
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/criteria-schema.js', ['../criteria-schema.js', 'text/javascript; charset=utf-8']],
    ['/research.js', ['research.js', 'text/javascript; charset=utf-8']],
    ['/swarm.js', ['swarm.js', 'text/javascript; charset=utf-8']],
    ['/swarm.css', ['swarm.css', 'text/css; charset=utf-8']],
    ['/guru.js', ['guru.js', 'text/javascript; charset=utf-8']],
    ['/guru.css', ['guru.css', 'text/css; charset=utf-8']],
    ...Array.from({ length: 8 }, (_, index) => [
      `/avatars/agent-${index + 1}.svg`, [`avatars/agent-${index + 1}.svg`, 'image/svg+xml'],
    ]),
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/vendor/marked.js', ['../node_modules/marked/lib/marked.umd.js', 'text/javascript; charset=utf-8']],
    ['/vendor/purify.js', ['../node_modules/dompurify/dist/purify.min.js', 'text/javascript; charset=utf-8']],
  ]);
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.host !== new URL(origin).host) { send(403, {ok:false}); return; }
    if (req.method === 'GET' && assets.has(req.url)) {
      const [file, mime] = assets.get(req.url);
      res.writeHead(200, {'Content-Type':mime});
      fs.createReadStream(path.join(root, 'ui/gui', file)).pipe(res); return;
    }
    const streaming = req.url === '/api/stream';
    if ((!streaming && req.url !== '/api') || req.method !== 'POST') { send(404,{ok:false}); return; }
    if (req.headers.origin !== origin || req.headers['x-itt-token'] !== token ||
        req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') { send(403,{ok:false}); return; }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { send(413,{ok:false}); return; }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          Object.keys(request).some(key => !['method','params'].includes(key))) throw new Error('envelope');
        if (size > 16384 && request.method !== 'market.guru') { send(413,{ok:false}); return; }
        if (streaming && !['market.backtest', 'market.portfolio'].includes(request.method)) throw new Error('stream');
      if (['copilot.status', 'copilot.analyze', 'copilot.criteria'].includes(request.method)) {
        try {
          const call = validateCopilotRequest(request.method, request.params);
          copilotService ??= buildCopilotService({ backend, root });
          const result = call.method === 'copilot.status'
            ? await copilotService.status() : call.method === 'copilot.criteria'
              ? await copilotService.criteria(call.params) : await copilotService.analyze(call.params);
          send(200, { ok: true, result });
        } catch (error) {
          const safe = copilotError(error);
          send(safe.code === 'busy' ? 409 : 400, { ok: false, error: safe });
        }
        return;
      }
      if (typeof request.method === 'string' && request.method.startsWith('guru.')) {
        try {
          const params = validateGuruRequest(request.method, request.params);
          guruService ??= buildGuruService();
          send(200, { ok: true, result: await guruService.request(request.method, params) });
        } catch (error) {
          const known = error instanceof GuruServiceError;
          send(known ? error.status : 502, { ok: false, error: {
            code: known ? error.code : 'GURU_UNAVAILABLE',
            message: known ? error.message : 'The reference Guru feed is unavailable; no substitute data was used.',
          } });
        }
        return;
      }
      const call = guiRequest(request.method, request.params, root);
      if (backendFailed) { send(503,{ok:false,error:{code:'exited',message:safeError({code:'exited'})}}); return; }
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.flushHeaders();
        const write = record => { if (!res.destroyed) res.write(JSON.stringify(record) + '\n'); };
        try {
          const result = await backend.request(call.method + '.stream', call.params, {
            onProgress: data => write({ event: 'progress', data }),
          });
          write({ event: 'result', result });
        } catch (error) { write({ event: 'error', error: { code: safeErrorCode(error), message: safeError(error) } }); }
        res.end(); return;
      }
      try { send(200,{ok:true,result:await backend.request(call.method, call.params)}); }
      catch (error) { send(400,{ok:false,error:{code:safeErrorCode(error),message:safeError(error)}}); }
    } catch { send(400,{ok:false,error:{code:'invalid_request',message:'Invalid GUI request.'}}); }
  });
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port,'127.0.0.1',resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url:`${origin}/#token=${token}`, origin, token, async close() {
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    try { await copilotService?.close(); }
    finally {
      await backend.close();
      for (const socket of connections) socket.destroy();
      await stopped;
    }
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startGUI();
  console.log(`Open the local GUI: ${app.url}`);
  process.once('SIGINT', async () => { await app.close(); });
}