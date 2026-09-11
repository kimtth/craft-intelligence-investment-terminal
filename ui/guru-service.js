/**
 * Read-only reference feed adapter; independently written from observed contracts.
 * Contract discovery: 2026-09-11, https://easyinvesting.app/#/guru and the public
 * /assets/index-CrfvzS_m.js API call strings; verified unauthenticated GETs below.
 * No third-party implementation, credentials, SEC ingestion or financial math.
 *
 * data preserves the provider schema, nulls, flags and note verbatim. Returns,
 * pct_change and pct_portfolio are percentage points (23.8 means 23.8%, not .238).
 * Historical holdings do NOT time-slice returns: the observed 2026-03-31 response
 * still had return_end_period=2026-06-30. Always show return_start/end separately.
 * funds: {funds:[{cik,name,manager,active,show_in_default,latest_period,latest_nav,
 *   returns,returns_current,return_start_period,return_end_period,recent_changes}],note}
 * quarters: {quarters:[{period,fund_count,not_filed_count}],default_period,
 *   total_visible_funds,cache_age_h}
 * fund: {fund,period,periods_available,holdings,returns,total_value,position_count,
 *   filing_status,is_empty_filing,latest_market_period,latest_filed_period,note,...}
 * holdings: [{cusip,ticker,name,shares,value,pct_portfolio,change_type,pct_change,prev_shares}]
 * popular/buys/sells: {period,manager_funds:[{ticker,name,manager_count,total_value,
 *   total_shares?,top_holders?:[{cik,manager,fund,value}]}],note,cache_age_h,...}
 * changes: {period,changes:[{cik,fund_name,manager,period,cusip,ticker,name,
 *   change_type,prev_shares,new_shares,pct_change,value}],fund_status,
 *   filed_count,not_filed_count,note}
 * fund_status: [{cik,name,manager,category,position_count,total_value,
 *   latest_filed_period,is_index,is_empty_filing,filing_status}]
 */

const ORIGIN = 'https://easyinvesting.app';
const TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^\d{10}$/;
const PERIOD = /^(19|20)\d{2}-(03-31|06-30|09-30|12-31)$/;
const TYPES = ['NEW', 'INC', 'DEC', 'SOLD'];
const MODES = ['popular', 'buys', 'sells'];
const LIMITATIONS = Object.freeze([
  'Data and estimated performance are supplied by easyinvesting.app, not independently verified SEC calculations by ITT.',
  'The provider describes returns as estimates from quarter-end 13F snapshots; intraperiod trades, delisted/M&A securities and some foreign stocks are omitted. These are not actual fund returns.',
  '13F disclosures are delayed and incomplete portfolios. Changes in reported holdings do not establish actual trade dates or prices.',
  'Return coverage can differ from filing history and the selected holdings quarter. Historical holdings responses may include later performance; they are not point-in-time backtests.',
  'Returns, portfolio weights and percentage changes are already in percent units, not decimal fractions. Missing values remain null; preserve returns_current and filing_status.',
  'This depends on an undocumented public reference API with unknown collection schedule, rate limits and SLA. Local refresh does not trigger upstream collection.',
  'Public accessibility is not a redistribution license. Data-use rights must be checked before redistribution or commercial use.',
]);

export class GuruServiceError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'GuruServiceError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  throw new GuruServiceError('GURU_INVALID_REQUEST', message, 400);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Syntactic validation only. request() also verifies CIKs against fetched funds. */
export function validateGuruRequest(method, params = {}) {
  const fields = {
    'guru.funds': [],
    'guru.quarters': [],
    'guru.fund': ['id', 'period'],
    'guru.popular': ['period', 'mode', 'include_index', 'limit'],
    'guru.changes': ['period', 'type', 'cik', 'include_index', 'limit'],
  };
  if (typeof method !== 'string' || !Object.hasOwn(fields, method)) invalid('Unsupported Guru method.');
  if (!object(params) || ![Object.prototype, null].includes(Object.getPrototypeOf(params))) invalid('Guru params must be an object.');
  const allowed = [...fields[method], 'refresh'];
  for (const key of Reflect.ownKeys(params)) {
    if (!allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(params, key), 'value')) invalid('Unknown Guru parameter.');
  }
  const p = { ...params };
  for (const key of ['refresh', 'include_index']) {
    if (Object.hasOwn(p, key) && typeof p[key] !== 'boolean') invalid(`${key} must be boolean.`);
  }
  if (method === 'guru.fund' && !Object.hasOwn(p, 'id')) invalid('id is required.');
  for (const key of ['id', 'cik']) {
    if (Object.hasOwn(p, key) && (typeof p[key] !== 'string' || !ID.test(p[key]))) invalid(`${key} must be a 10-digit CIK from guru.funds.`);
  }
  if (Object.hasOwn(p, 'period') && (typeof p.period !== 'string' || !PERIOD.test(p.period))) invalid('period must be a quarter-end date (YYYY-MM-DD, 1900–2099).');
  if (Object.hasOwn(p, 'mode') && !MODES.includes(p.mode)) invalid('mode must be popular, buys or sells.');
  if (Object.hasOwn(p, 'type') && !TYPES.includes(p.type)) invalid('type must be NEW, INC, DEC or SOLD; omit for all.');
  if (Object.hasOwn(p, 'limit') && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > (method === 'guru.changes' ? 200 : 30))) invalid('limit is outside the supported range.');
  p.refresh ??= false;
  if (method === 'guru.popular' || method === 'guru.changes') {
    p.include_index ??= false;
    p.limit ??= method === 'guru.changes' ? 200 : 30;
  }
  if (method === 'guru.popular') p.mode ??= 'popular';
  return p;
}

function schemaFailure() {
  throw new GuruServiceError('GURU_INVALID_RESPONSE', 'The reference returned an unsupported Guru response.');
}

function validateData(kind, data) {
  if (!object(data) || Object.hasOwn(data, 'error') || data.ok === false) schemaFailure();
  const rows = (value, max, predicate) => {
    if (!Array.isArray(value) || value.length > max || !value.every(row => object(row) && predicate(row))) schemaFailure();
  };
  const cik = row => typeof row.cik === 'string' && ID.test(row.cik);
  const name = row => typeof row.name === 'string';
  const number = value => typeof value === 'number' && Number.isFinite(value);
  const period = value => typeof value === 'string' && PERIOD.test(value);
  if (kind === 'funds') {
    rows(data.funds, 1000, row => cik(row) && name(row));
    if (new Set(data.funds.map(row => row.cik)).size !== data.funds.length) schemaFailure();
  } else if (kind === 'quarters') {
    rows(data.quarters, 800, row => period(row.period) && Number.isInteger(row.fund_count) && row.fund_count >= 0);
    if (data.default_period != null && !data.quarters.some(row => row.period === data.default_period)) schemaFailure();
  } else if (kind === 'fund') {
    if (!object(data.fund) || !cik(data.fund) || !name(data.fund) || !(data.period === null || period(data.period))) schemaFailure();
    if (!Array.isArray(data.periods_available) || data.periods_available.length > 800 || !data.periods_available.every(period)) schemaFailure();
    rows(data.holdings, 20000, row => typeof row.cusip === 'string' && name(row) && number(row.shares) && number(row.value));
    if (!(data.returns === null || object(data.returns))) schemaFailure();
  } else if (kind === 'recent-changes') {
    if (!period(data.period)) schemaFailure();
    rows(data.changes, 200, row => cik(row) && name(row) && TYPES.includes(row.change_type) && number(row.value));
    rows(data.fund_status, 1000, row => cik(row) && name(row));
  } else {
    if (!period(data.period)) schemaFailure();
    rows(data.manager_funds, 30, row => name(row) && Number.isInteger(row.manager_count) && row.manager_count >= 0 && number(row.total_value));
    if (data.fund_status !== undefined) rows(data.fund_status, 1000, row => cik(row) && name(row));
  }
  // JSON.parse accepts overflowing numeric literals such as 1e400; reject them.
  const pending = [data];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) schemaFailure();
    if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
}

/** Fixed-origin GETs only. Configurable lower safety limits support isolated tests. */
export function buildGuruService({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 15000,
  maxResponseBytes = MAX_BYTES,
  cacheTtlMs = TTL_MS,
  maxCacheEntries = 64,
  maxCacheBytes = 32 * 1024 * 1024,
  maxInFlight = 8,
} = {}) {
  for (const [value, max] of [[timeoutMs, 30000], [maxResponseBytes, MAX_BYTES], [cacheTtlMs, TTL_MS], [maxCacheEntries, 64], [maxCacheBytes, 32 * 1024 * 1024], [maxInFlight, 8]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Invalid Guru service safety limit.');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('fetchImpl and now must be functions.');
  const cache = new Map();
  const inFlight = new Map();
  let cacheBytes = 0;
  let rateLimitedUntil = 0;

  function evict(key) {
    cacheBytes -= cache.get(key).bytes;
    cache.delete(key);
  }

  async function load(path, kind, refresh) {
    const url = `${ORIGIN}/api/guru/${path}`;
    // path is constructed exclusively below, never accepted from callers.
    const existing = cache.get(url);
    if (existing && now() - existing.time >= cacheTtlMs) evict(url);
    if (inFlight.has(url)) return { entry: await inFlight.get(url), cached: false };
    if (!refresh && cache.has(url)) return { entry: cache.get(url), cached: true };
    if (now() < rateLimitedUntil) throw new GuruServiceError('GURU_RATE_LIMITED', 'The reference rate limit is active; try later.', 429);
    if (inFlight.size >= maxInFlight) throw new GuruServiceError('GURU_BUSY', 'Too many Guru requests are in progress.', 503);
    // A failed explicit refresh must not silently resurrect an older result.
    if (cache.has(url)) evict(url);
    const controller = new AbortController();
    let timer;
    let reader;
    const work = (async () => {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (response.redirected || (response.url && response.url !== url)) throw new GuruServiceError('GURU_REDIRECT', 'The reference redirected the request; it was refused.');
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - now()) / 1000;
        rateLimitedUntil = now() + Math.max(60000, Number.isFinite(seconds) ? seconds * 1000 : 60000);
        throw new GuruServiceError('GURU_RATE_LIMITED', 'The reference rate-limited the request; no retry was attempted.', 429);
      }
      if (response.status !== 200) throw new GuruServiceError('GURU_HTTP_ERROR', `The reference returned HTTP ${response.status}.`);
      const mime = response.headers.get('content-type') || '';
      if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|\s*$)/i.test(mime)) schemaFailure();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) throw new GuruServiceError('GURU_RESPONSE_TOO_LARGE', 'The reference response exceeds the supported size.');
      if (!response.body?.getReader) schemaFailure();
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (controller.signal.aborted) throw new GuruServiceError('GURU_TIMEOUT', 'The reference request timed out.', 504);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxResponseBytes) throw new GuruServiceError('GURU_RESPONSE_TOO_LARGE', 'The reference response exceeds the supported size.');
        chunks.push(Buffer.from(part.value));
      }
      let data;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch { schemaFailure(); }
      validateData(kind, data);
      const time = now();
      return { data, time, bytes, url };
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GuruServiceError('GURU_TIMEOUT', 'The reference request timed out.', 504));
      }, timeoutMs);
    });
    const task = Promise.race([work, timeout]).catch(error => {
      if (error instanceof GuruServiceError) throw error;
      throw new GuruServiceError('GURU_UNAVAILABLE', 'The reference Guru feed is unavailable; no substitute data was used.');
    });
    inFlight.set(url, task);
    try {
      const entry = await task;
      if (entry.bytes <= maxCacheBytes) {
        for (const [key, value] of cache) if (now() - value.time >= cacheTtlMs) evict(key);
        while (cache.size >= maxCacheEntries || cacheBytes + entry.bytes > maxCacheBytes) evict(cache.keys().next().value);
        cache.set(url, entry);
        cacheBytes += entry.bytes;
      }
      return { entry, cached: false };
    } catch (error) {
      if (error instanceof GuruServiceError) throw error;
      throw new GuruServiceError('GURU_UNAVAILABLE', 'The reference Guru feed is unavailable; no substitute data was used.');
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      inFlight.delete(url);
    }
  }

  return {
    async request(method, params = {}) {
      const p = validateGuruRequest(method, params);
      const id = p.id ?? p.cik;
      if (id !== undefined) {
        const { entry } = await load('funds', 'funds', false);
        if (!entry.data.funds.some(fund => fund.cik === id)) invalid('Unknown fund CIK; select an id returned by guru.funds.');
      }
      if ((method === 'guru.popular' || method === 'guru.changes') && p.period === undefined) {
        const { entry } = await load('quarters', 'quarters', p.refresh);
        p.period = entry.data.default_period ?? entry.data.quarters[0]?.period;
        if (!p.period) throw new GuruServiceError('GURU_NO_PERIOD', 'The reference has no available reporting quarter.');
      }
      let kind;
      let path;
      if (method === 'guru.fund') {
        kind = 'fund';
        path = `fund/${p.id}/holdings${p.period ? `?period=${p.period}` : ''}`;
      } else if (method === 'guru.popular' || method === 'guru.changes') {
        kind = method === 'guru.popular' ? p.mode : 'recent-changes';
        const query = new URLSearchParams({ period: p.period, include_index: String(p.include_index), limit: String(p.limit) });
        if (p.type) query.set('type', p.type);
        if (p.cik) query.set('cik', p.cik);
        path = `${kind}?${query}`;
      } else {
        kind = method === 'guru.funds' ? 'funds' : 'quarters';
        path = kind;
      }
      const { entry, cached } = await load(path, kind, p.refresh);
      if ((p.id && entry.data.fund.cik !== p.id) || (p.period && entry.data.period !== p.period)) {
        if (cache.has(entry.url)) evict(entry.url);
        schemaFailure();
      }
      return {
        data: structuredClone(entry.data),
        source: {
          provider: 'easyinvesting.app', url: entry.url,
          referencePage: `${ORIGIN}/#/guru`, fetchedAt: new Date(entry.time).toISOString(),
          cached, cacheAgeSeconds: Math.max(0, (now() - entry.time) / 1000),
          cacheTtlSeconds: cacheTtlMs / 1000,
          upstreamCacheAgeHours: entry.data.cache_age_h ?? null,
          schema: 'easyinvesting-guru-raw-v1', units: 'provider-percent-points-and-USD',
          independentlyVerified: false,
        },
        limitations: [...LIMITATIONS],
      };
    },
  };
}