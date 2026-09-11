/* Native DOM presentation only. Python owns saved market data; Node owns Copilot SDK calls. */
import { criterion as validCriterion, CRITERIA_OPERANDS as OPERANDS, CRITERIA_OPERATORS as OPERATORS } from '/criteria-schema.js';

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const SYMBOLS = ['SPY', 'QQQ', 'IWM', 'MSFT'];
  const validSymbol = value => typeof value === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(value);
  const savedSymbols = () => state.snapshot?.symbols.map(item => item.symbol) || [];
  let research;
  const NAMES = { SPY: 'S&P 500 ETF', QQQ: 'Nasdaq-100 ETF', IWM: 'Russell 2000 ETF', MSFT: 'Microsoft' };
  const PERIODS = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252, Archive: null };
  const INDICATORS = { sma20: 'SMA20', sma50: 'SMA50', rsi14: 'RSI14' };
  const TECHNICAL_ROWS = [
    ['rsi14', 'RSI (14)', 'Relative strength of smoothed gains and losses; 30 / 70 are reference bands.'],
    ['stoch9_6', 'STOCH (9, 6)', 'Own interpretation: 6-observation simple smoothing of 9-observation stochastic %K; not Investing.com parity.'],
    ['stochrsi14', 'StochRSI (14)', 'RSI relative to its 14-observation range; see backend definition for scale and smoothing.'],
    ['macd12_26', 'MACD (12, 26)', 'EMA12 − EMA26; signal uses 9-observation smoothing.'],
    ['adx14', 'ADX (14)', 'Directional movement strength, not direction; +DI / −DI describe directional components.'],
    ['williams_r14', 'Williams %R (14)', 'Close position within the 14-observation high / low range; −80 / −20 are reference bands.'],
    ['cci14', 'CCI (14)', 'Typical price deviation from its mean, scaled by mean deviation; ±100 are reference bands.'],
    ['atr14', 'ATR (14)', 'Smoothed true range in price units; volatility, not direction.'],
    ['highs_lows14', 'Highs / Lows (14)', 'Own midrange formula: close − (highest high over 14 + lowest low over 14) / 2; not Investing.com parity.'],
    ['ultimate7_14_28', 'Ultimate (7, 14, 28)', 'Buying pressure relative to true range over three observation windows.'],
    ['roc12', 'ROC (12)', 'Percentage close change over 12 observations.'],
    ['bull13', 'Bull power (13)', 'High − EMA13; price-unit distance, not a recommendation.'],
    ['bear13', 'Bear power (13)', 'Low − EMA13; price-unit distance, not a recommendation.'],
  ];
  // Categories explain readings; they never assign directional votes or thresholds.
  const TECHNICAL_CATEGORIES = {
    trend: ['Trend', 'Trend strength / direction'],
    momentum: ['Momentum', 'Pace of price changes'],
    volatility: ['Volatility', 'Size of price swings'],
    position: ['Price position', 'Price within a range / baseline'],
  };
  const INDICATOR_CATEGORIES = {
    rsi14: 'momentum', stoch9_6: 'position', stochrsi14: 'momentum', macd12_26: 'trend',
    adx14: 'trend', williams_r14: 'position', cci14: 'position', atr14: 'volatility',
    highs_lows14: 'position', ultimate7_14_28: 'momentum', roc12: 'momentum',
    bull13: 'position', bear13: 'position',
  };
  const ICON_PATHS = {
    trend: 'M3 18 8 12 13 15 21 5M16 5h5v5',
    momentum: 'M3 13h4l3-8 4 14 3-8h4',
    volatility: 'M4 7h16M4 17h16M8 4v6M16 14v6',
    position: 'M5 4v16M19 4v16M5 12h14M10 9l3 3-3 3',
    markets: 'M4 4v16h16M8 16V9M13 16V5M18 16v-5',
    backtest: 'M4 5h16v14H4zM8 9l3 3-3 3M14 15h3',
    research: 'M10 3v6L4 19q-1 2 2 2h12q3 0 2-2L14 9V3M8 3h8M8 15h8',
    swarm: 'M9 5h6M6 8v8M18 8v8M9 19h6M3 2h6v6H3zM15 2h6v6h-6zM3 16h6v6H3zM15 16h6v6h-6z',
    fetch: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
    verify: 'm12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7zM8 12l3 3 5-6',
    review: 'M5 3h14v18H5zM8 8l1 1 2-2M13 8h3M8 15l1 1 2-2M13 15h3',
    run: 'm8 4 12 8-12 8z',
    Buy: 'M12 20V4M5 11l7-7 7 7',
    Sell: 'M12 4v16M5 13l7 7 7-7',
    Neutral: 'M4 12h16',
    Unavailable: 'M4 12h5M15 12h5',
  };
  const MA_PERIODS = [5, 10, 20, 50, 100, 200];
  const TOKEN_KEY = 'itt.gui.session-token.v1';
  const state = { snapshot: null, symbol: 'SPY', period: 'Archive', tab: 'chart',
    marketBusy: false, verification: 'Not loaded', hoverIndex: null,
    selectedTimestamps: {}, chartMode: 'candles', volume: true, sma20: true, sma50: true, rsi14: true };
  const copilot = { identity: null, resultIdentity: null, observedIdentity: null,
    ready: false, models: [], busy: false, checking: false, blocked: false };
  const backtest = { source: null, selection: null, revision: 0, reviewed: null, busy: false, generating: false,
    ruleSource: 'natural', proposal: null, proposalQuestion: null, proposalIdentity: null,
    result: null, pages: { signals: 0, fills: 0, decisions: 0 } };
  const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

  // A tab-scoped key survives reload; never put credentials into DOM, logs or requests' URLs.
  let token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  let tokenPersistence = true;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else token = sessionStorage.getItem(TOKEN_KEY) || '';
  } catch { tokenPersistence = false; }
  if (new URLSearchParams(location.hash.slice(1)).has('token')) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  const ERRORS = {
    auth_required: 'Session authentication is missing. Reopen the authenticated URL from the local GUI launcher.',
    unauthorized: 'Session authentication expired. Reopen the authenticated URL from the local GUI launcher.',
    forbidden: 'This session has no access. Reopen the local GUI launcher URL.',
    network_error: 'Cannot connect to the local API. Check that the GUI server is running.',
    invalid_response: 'Invalid local API response. No substitute data is used.',
    invalid_snapshot: 'No usable Yahoo snapshot. No substitute prices are used.',
    input_rejected: 'The backend rejected the input or saved data. Check criteria, dates, asset alignment and saved data.',
    io_failure: 'The backend could not read a required local file.',
    invalid_params: 'Invalid request parameters.',
    schema_rejected: 'The data format does not match the backend contract.',
    method_not_found: 'The connected backend does not support this operation.',
    missing_interpreter: 'The repository Python environment is unavailable.',
    spawn_failed: 'Could not start the local Python backend.',
    exited: 'The Python backend exited. No automatic retry.',
    closed: 'The backend connection closed. No automatic retry.',
    busy: 'The backend is busy. Wait for the current operation to finish.',
    storage_failed: 'The backend could not save the records.',
    internal_error: 'The backend operation failed. No substitute data is used.',
  };
  const fault = code => Object.assign(new Error(ERRORS[code] || 'Operation failed. No automatic retry.'), { code });
  const message = error => ERRORS[error?.code] || 'Operation failed. No automatic retry.';
  async function api(method, params = {}) {
    if (!token) throw fault('auth_required');
    let response;
    try {
      response = await fetch('/api', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ITT-Token': token },
        body: JSON.stringify({ method, params }) });
    } catch { throw fault('network_error'); }
    if (response.status === 401 || response.status === 403) {
      token = '';
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Tab memory is already cleared. */ }
      throw fault('unauthorized');
    }
    let envelope;
    try { envelope = await response.json(); } catch { throw fault('invalid_response'); }
    if (!envelope || typeof envelope.ok !== 'boolean') throw fault('invalid_response');
    if (!envelope.ok) throw fault(envelope.error?.code);
    if (!response.ok || !Object.hasOwn(envelope, 'result')) throw fault('invalid_response');
    return envelope.result;
  }

  // Streaming uses the same local token/envelope, never retries or invents progress.
  async function streamApi(method, params, onProgress) {
    if (!token) throw fault('auth_required');
    let response;
    try {
      response = await fetch('/api/stream', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ITT-Token': token },
        body: JSON.stringify({ method, params }) });
    } catch { throw fault('network_error'); }
    if ([401, 403].includes(response.status)) {
      token = '';
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Tab memory cleared. */ }
      throw fault('unauthorized');
    }
    if (!response.ok) {
      let envelope;
      try { envelope = await response.json(); } catch { throw fault('invalid_response'); }
      throw Object.assign(fault(envelope.error?.code), { streamMessage: envelope.error?.message });
    }
    if (!response.body) throw fault('invalid_response');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', terminal = false, result;
    const consume = line => {
      if (!line.trim()) return;
      if (terminal) throw fault('invalid_response');
      let record;
      try { record = JSON.parse(line); } catch { throw fault('invalid_response'); }
      if (record.event === 'error') throw Object.assign(fault(record.error?.code), { streamMessage: record.error?.message });
      if (record.event === 'result' && Object.hasOwn(record, 'result')) { terminal = true; result = record.result; return; }
      const p = record.data;
      if (record.event !== 'progress' || !['strategy', 'benchmark'].includes(p?.phase)
          || !Number.isSafeInteger(p.completed) || !Number.isSafeInteger(p.total)
          || p.total < 1 || p.completed < 0 || p.completed > p.total || typeof p.date !== 'string'
          || ['nav', 'cagr', 'max_drawdown'].some(key => p[key] !== null && !numeric(p[key]))) throw fault('invalid_response');
      onProgress(p);
    };
    try {
      while (!terminal) {
        let chunk;
        try { chunk = await reader.read(); } catch { throw fault('network_error'); }
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary;
        while ((boundary = pending.indexOf('\n')) >= 0) {
          consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 1);
        }
        if (chunk.done) { if (pending.trim()) consume(pending); break; }
      }
      if (!terminal) throw fault('invalid_response');
      return result;
    } finally { try { await reader.cancel(); } catch { /* No retry on cleanup failure. */ } reader.releaseLock(); }
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }
  function visualIcon(name) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'ui-glyph');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.dataset.icon = name;
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', ICON_PATHS[name]);
    icon.append(path);
    return icon;
  }
  const raw = value => value === null || value === undefined ? 'Unknown'
    : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isFinite(Number(value));
  const price = value => numeric(value) ? Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  // Volume is an integer string: use BigInt to avoid rounding even unusually large stored values.
  function volume(value) {
    if (value === undefined || value === null) return 'Unknown';
    try { return BigInt(value).toLocaleString('en-US'); } catch { return raw(value); }
  }
  function pairs(parent, entries) {
    parent.replaceChildren();
    for (const [label, value] of entries) {
      const row = node('div');
      row.append(node('dt', label), node('dd', raw(value)));
      parent.append(row);
    }
  }
  function setError(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
  const current = () => state.snapshot?.symbols.find(item => item.symbol === state.symbol);
  const summary = symbol => state.snapshot?.summary.find(item => item.symbol === symbol);
  function visibleBars() {
    const bars = current()?.bars || [];
    return PERIODS[state.period] === null ? bars : bars.slice(-PERIODS[state.period]);
  }
  // Validate alignment, then slice backend strings with exactly the bars' archive offset.
  // Missing/unsupported contracts are explicit; never substitute a browser calculation.
  function visibleTechnicals() {
    const item = current(), technicals = item?.technicals, count = visibleBars().length;
    const supported = technicals?.version === '1' && technicals.basis === 'provider_close';
    const offset = (item?.bars.length || 0) - count;
    return Object.fromEntries(Object.keys(INDICATORS).map(key => {
      const values = technicals?.[key];
      const aligned = supported && Array.isArray(values) && values.length === item.bars.length
        && values.every(value => value === null || (typeof value === 'string' && numeric(value)));
      return [key, aligned ? values.slice(offset) : null];
    }));
  }
  function indicatorText(values, index) {
    return !values ? 'Unavailable · backend' : values[index] === null ? 'Unavailable · warm-up / gap' : price(values[index]);
  }
  function indicatorPairs(parent, technicals, index) {
    pairs(parent, Object.entries(INDICATORS).map(([key, label]) => [label, indicatorText(technicals[key], index)]));
    [...parent.children].forEach((row, i) => {
      const key = Object.keys(INDICATORS)[i], value = technicals[key]?.[index];
      row.dataset.indicator = key;
      row.lastElementChild.title = value === undefined ? 'Unavailable · backend did not return an aligned series' : raw(value === null ? 'null · warm-up / gap' : value);
      row.lastElementChild.dataset.value = value === undefined ? 'unavailable' : JSON.stringify(value);
    });
  }
  // Summary lookup always uses the full archive index, never the visible-window index.
  function summarySeries(item, key) {
    const contract = item?.technicals;
    if (contract?.version !== '1' || contract.basis !== 'provider_close') return null;
    const values = key === 'rsi14' ? contract.rsi14
      : Object.hasOwn(contract.series || {}, key) ? contract.series[key]
      : ['sma20', 'sma50'].includes(key) ? contract[key] : undefined;
    return Array.isArray(values) && values.length === item.bars.length
      && values.every(value => value === null || (typeof value === 'string' && numeric(value))) ? values : null;
  }
  function technicalValue(cell, value) {
    cell.dataset.value = value === undefined ? 'unavailable' : value === null ? 'null' : value;
    cell.title = value === undefined ? 'Unavailable' : value === null ? 'null' : value;
    if (value === undefined || value === null) {
      const description = value === null ? 'Insufficient history / undefined' : 'Unavailable';
      const dash = node('span', '—'); dash.setAttribute('aria-hidden', 'true');
      cell.replaceChildren(dash, node('span', description, 'sr-only'));
      cell.setAttribute('aria-label', description);
    } else cell.textContent = Number(value).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
    cell.classList.add('technical-value');
    if (value === undefined || value === null) cell.classList.add('technical-missing');
  }
  // Validate the backend envelope and selected full-archive entry, never derive a vote.
  function selectedSignal(item, index) {
    const contract = item?.signals;
    const statuses = ['Buy', 'Sell', 'Neutral', 'Unavailable'];
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const text = value => typeof value === 'string' && value.trim().length > 0;
    if (contract?.version !== 'technical-vote-v1' || contract.basis !== 'provider_close'
        || !text(contract.rule) || !Array.isArray(item?.bars)
        || !Number.isInteger(index) || index < 0 || index >= item.bars.length
        || !Array.isArray(contract.observations) || contract.observations.length !== item.bars.length) return null;
    const observation = contract.observations[index];
    if (!record(observation) || !statuses.includes(observation.status) || !record(observation.counts)
        || !statuses.every(status => Number.isSafeInteger(observation.counts[status])
          && observation.counts[status] >= 0 && observation.counts[status] <= 3)
        || !Array.isArray(observation.reasons) || observation.reasons.length !== 3) return null;
    const ids = ['trend', 'macd', 'rsi'];
    if (!ids.every(id => observation.reasons.filter(reason => reason?.id === id).length === 1)
        || !observation.reasons.every(reason => record(reason) && text(reason.label)
          && statuses.includes(reason.status) && text(reason.rule) && text(reason.explanation)
          && record(reason.values) && Object.keys(reason.values).length > 0
          && Object.values(reason.values).every(value => value === null || (typeof value === 'string' && numeric(value))))) return null;
    return { contract, observation };
  }
  // Presentation alias only, scoped to signal contract text (including "not neutral").
  // Never mutate backend statuses, counts, values or rules, or translate user/model text.
  const signalText = text => text.replace(/\bneutral\b/gi, 'Hold');
  function renderSignal(bar, item, index) {
    const selected = index >= 0 && item?.bars[index]?.timestamp === bar?.timestamp ? bar : null;
    const signal = selected ? selectedSignal(item, index) : null;
    const status = signal?.observation.status || 'Unavailable';
    const timestamp = selected ? String(selected.timestamp) : '';
    for (const id of ['signal-button', 'signal-details', 'signal-vote-summary']) {
      const element = $(id);
      element.dataset.status = status;
      element.dataset.timestamp = timestamp;
      element.dataset.symbol = selected ? item.symbol : '';
      element.dataset.date = selected ? selected.date : '';
      element.dataset.archive = selected ? String(state.snapshot?.manifest?.id || '') : '';
    }
    $('signal-status').textContent = signalText(status);
    $('signal-button').setAttribute('aria-label', `${signalText(status)} technical signal · show or hide reasons`);
    $('signal-selection').textContent = selected
      ? `Signal · ${item.symbol} · ${selected.date} · selected observation. Last close below is latest.`
      : 'Signal · no selected observation. Last close below is latest.';
    $('signal-availability').textContent = signal
      ? `${signalText(status)} · backend assessment of the selected observation; three proposed rule votes.`
      : selected ? 'Unavailable · missing, unsupported or malformed backend signal. No votes substituted.'
      : 'Unavailable · no selected observation loaded.';
    pairs($('signal-identity'), selected ? [['Selected symbol', item.symbol], ['Selected date', selected.date],
      ['Timestamp (Unix seconds)', selected.timestamp], ['Archive UUID', state.snapshot?.manifest?.id],
      ['Rule name / version', signal?.contract.version], ['Price basis', signal?.contract.basis]] : []);
    $('signal-rule').textContent = signal ? signalText(signal.contract.rule) : '';
    const counts = signal ? ['Buy', 'Sell', 'Neutral', 'Unavailable'].map(vote => [signalText(vote), signal.observation.counts[vote]]) : [];
    pairs($('signal-counts'), counts);
    const tiles = $('signal-vote-tiles'); tiles.replaceChildren();
    for (const [id, label] of [['trend', 'Trend'], ['macd', 'MACD'], ['rsi', 'RSI']]) {
      const reason = signal?.observation.reasons.find(entry => entry.id === id);
      const vote = reason?.status || 'Unavailable';
      const tile = node('div', undefined, 'signal-vote-tile');
      tile.dataset.rule = id; tile.dataset.status = vote;
      tile.title = reason ? signalText(`${reason.label}: ${reason.explanation}`) : 'No validated backend vote available.';
      const value = node('strong', undefined, 'signal-vote-status');
      value.append(visualIcon(vote), node('span', signalText(vote)));
      tile.append(node('span', label, 'signal-vote-label'), value);
      tiles.append(tile);
    }
    $('signal-vote-availability').textContent = signal ? 'Selected observation · backend votes'
      : 'Unavailable · no validated backend votes. No votes substituted.';
    pairs($('signal-vote-counts'), counts);
    const reasons = $('signal-reasons');
    reasons.replaceChildren();
    if (!signal) return;
    for (const reason of signal.observation.reasons) {
      const row = node('section', undefined, 'signal-reason'), heading = node('h4');
      row.dataset.testid = 'signal-reason'; row.dataset.rule = reason.id;
      row.dataset.id = reason.id; row.dataset.status = reason.status;
      heading.append(node('span', signalText(reason.label)), node('strong', signalText(reason.status), 'signal-reason-status'));
      const values = node('dl', undefined, 'signal-values');
      pairs(values, Object.entries(reason.values).map(([key, value]) => [key, value === null ? 'null · unavailable' : value]));
      // Preserve backend decimal strings verbatim, including trailing zeros; text only.
      [...values.children].forEach((entry, valueIndex) => {
        const value = Object.values(reason.values)[valueIndex];
        entry.lastElementChild.dataset.value = value === null ? 'null' : value;
      });
      const calculation = node('details', undefined, 'technical-definition');
      calculation.append(node('summary', 'Calculation'), node('p', signalText(reason.rule)));
      row.append(heading, node('p', signalText(reason.explanation)), values, calculation);
      reasons.append(row);
    }
  }
  function renderTechnicalSummary(bar) {
    const item = current(), contract = item?.technicals;
    const index = bar ? (item?.bars || []).findIndex(entry => entry.timestamp === bar.timestamp) : -1;
    renderSignal(bar, item, index);
    const panel = $('technical-summary');
    panel.dataset.timestamp = index >= 0 ? String(bar.timestamp) : '';
    panel.dataset.symbol = state.symbol;
    panel.dataset.date = index >= 0 ? bar.date : '';
    $('technical-summary-date').textContent = index >= 0 ? `${state.symbol} · ${bar.date} · selected observation`
      : state.marketBusy ? 'Reading archive…' : 'No observation loaded';
    const valueAt = key => index >= 0 ? summarySeries(item, key)?.[index] : undefined;
    const definition = key => contract?.version === '1' && contract.basis === 'provider_close'
      && typeof contract.definitions?.[key] === 'string' ? contract.definitions[key] : '';
    const body = $('technical-summary-body');
    body.replaceChildren();
    for (const [key, label, meaning] of TECHNICAL_ROWS) {
      const row = node('tr'), heading = node('th', label), cell = node('td'), explanation = node('td');
      row.dataset.testid = 'technical-row'; row.dataset.indicator = key;
      heading.scope = 'row';
      const category = INDICATOR_CATEGORIES[key], [categoryName, categoryMeaning] = TECHNICAL_CATEGORIES[category];
      row.dataset.category = category;
      const name = node('span', undefined, 'indicator-name');
      name.append(visualIcon(category), node('span', label));
      heading.replaceChildren(name, node('span', categoryName, 'indicator-category'));
      heading.title = categoryMeaning;
      technicalValue(cell, valueAt(key)); row.dataset.value = cell.dataset.value;
      explanation.append(node('span', meaning));
      const formula = definition(key);
      if (formula) {
        const details = node('details', undefined, 'technical-definition');
        details.append(node('summary', 'Calculation'), node('span', formula));
        explanation.append(details);
      }
      const companions = key === 'macd12_26' ? [['macd_signal9', 'Signal (9)']]
        : key === 'adx14' ? [['plus_di14', '+DI (14)'], ['minus_di14', '−DI (14)']] : [];
      for (const [companion, name] of companions) {
        const detail = node('span', `${name}: `, 'technical-definition'), value = node('span');
        value.dataset.indicator = companion;
        technicalValue(value, valueAt(companion));
        detail.append(value);
        detail.title = definition(companion);
        explanation.append(detail);
      }
      row.append(heading, cell, explanation); body.append(row);
    }
    const averages = $('moving-average-body'); averages.replaceChildren();
    for (const period of MA_PERIODS) {
      const row = node('tr'), heading = node('th', String(period)); heading.scope = 'row';
      row.dataset.testid = 'moving-average-row'; row.dataset.maPeriod = String(period);
      row.append(heading);
      for (const kind of ['sma', 'ema']) {
        const key = `${kind}${period}`, cell = node('td'); cell.dataset.indicator = key;
        technicalValue(cell, valueAt(key));
        if (definition(key)) cell.title += ` · ${definition(key)}`;
        row.append(cell);
      }
      averages.append(row);
    }
  }
  function delta(row) {
    if (row?.metric !== 'price_change_not_investment_return' || !numeric(row.pricechange_pct)) {
      return { text: 'Unknown', className: 'muted' };
    }
    const value = Number(row.pricechange_pct);
    return { text: `${value > 0 ? '+' : ''}${price(row.pricechange_pct)}%`,
      className: value > 0 ? 'positive' : value < 0 ? 'negative' : 'muted' };
  }
  function validSnapshot(value) {
    return value?.manifest?.kind === 'real_market_snapshot'
      && value.manifest.provider === 'Yahoo Finance'
      && Array.isArray(value.summary) && Array.isArray(value.symbols) && value.symbols.length > 0
      && value.symbols.length <= 10 && new Set(value.symbols.map(item => item.symbol)).size === value.symbols.length
      && value.symbols.every(item => validSymbol(item.symbol) && Array.isArray(item.bars)
        && item.bars.length > 0 && item.bars.every(bar => typeof bar.date === 'string'
          && Number.isSafeInteger(bar.timestamp)
          && ['open', 'high', 'low', 'close', 'volume'].every(field => numeric(bar[field]))
          && Number(bar.close) > 0));
  }

  function renderWatchlist() {
    const filter = $('watch-search').value.trim().toUpperCase();
    const list = $('watchlist');
    list.replaceChildren();
    for (const symbol of savedSymbols().filter(item => `${item} ${NAMES[item] || item}`.toUpperCase().includes(filter))) {
      const row = summary(symbol), change = delta(row);
      const button = node('button', undefined, 'watch-button');
      button.type = 'button';
      button.dataset.symbol = symbol;
      button.dataset.testid = `watch-${symbol}`;
      button.setAttribute('aria-label', symbol);
      button.setAttribute('aria-pressed', String(symbol === state.symbol));
      button.append(node('span', symbol, 'watch-symbol'), node('span', price(row?.last_price), 'watch-price'),
        node('span', NAMES[symbol] || symbol, 'watch-name'), node('span', change.text, `watch-delta ${change.className}`));
      button.title = `${symbol} · ${NAMES[symbol] || symbol} · Close ${raw(row?.last_price)} · Archive Δ ${raw(row?.pricechange_pct)}% · ${raw(row?.first_date)} — ${raw(row?.last_date)}`;
      button.addEventListener('click', () => {
        state.symbol = symbol;
        renderMarket();
        [...list.children].find(item => item.dataset.symbol === symbol)?.focus();
      });
      list.append(button);
    }
    $('watch-count').textContent = `${list.children.length} results`;
    if (!list.children.length) list.append(node('p', 'No matching symbols. Filter by literal ticker or instrument name.', 'panel-note'));
  }

  function renderContext() {
    $('workspace-location').textContent = `Markets / ${state.symbol}`;
    $('scope-currency').textContent = current()?.currency || 'USD';
  }
  function renderMarket() {
    renderWatchlist();
    renderContext();
    const item = current(), last = item?.bars.at(-1), change = delta(summary(state.symbol));
    $('instrument-title').textContent = state.symbol;
    $('instrument-mark').textContent = state.symbol[0];
    $('instrument-name').textContent = NAMES[state.symbol] || state.symbol;
    $('details-symbol').textContent = state.symbol;
    $('quote-currency').textContent = `· ${item?.currency || 'USD'}`;
    $('last-price').textContent = price(last?.close);
    $('last-price').title = raw(last?.close);
    $('price-change').textContent = change.text;
    $('price-change').className = `delta ${change.className}`;
    $('price-change').title = raw(summary(state.symbol)?.pricechange_pct);
    $('quote-date').textContent = last ? `As of ${last.date} · ${raw(item.exchange)}` : 'No saved observation loaded';
    $('snapshot-badge').textContent = state.snapshot ? 'Daily snapshot' : 'No snapshot';
    pairs($('instrument-details'), [['Symbol', state.symbol], ['Currency', item?.currency], ['Exchange', item?.exchange],
      ['Latest volume', last ? volume(last.volume) : null], ['Previous close', price(item?.bars.at(-2)?.close)],
      ['Stored bars', item?.bars.length], ['Skipped / missing', item?.missing_bars?.skipped_count],
      ['Filled bars', item?.missing_bars?.filled_count], ['Market cap', null], ['P/E ratio', null]]);
    $('integrity-state').textContent = state.verification;
    $('integrity-state').className = `badge ${state.verification === 'Saved bytes verified' ? 'positive' : 'warning'}`;
    $('collected-at').textContent = state.snapshot ? `Collected UTC · ${state.snapshot.manifest.collected_at}` : 'No collection timestamp';
    renderChart();
    renderPrices();
    renderObservations();
    renderSelection();
    renderSources();
  }

  // Selection is keyed by the provider timestamp, never by a rounded price or row position.
  // It is local view state only: no evidence or research decision is written here.
  function selectedBar() {
    const bars = visibleBars();
    const selected = bars.find(bar => bar.timestamp === state.selectedTimestamps[state.symbol]) || bars.at(-1);
    if (selected && state.selectedTimestamps[state.symbol] === undefined) state.selectedTimestamps[state.symbol] = selected.timestamp;
    return selected;
  }
  function renderSelection() {
    const bar = selectedBar(), manifest = state.snapshot?.manifest;
    renderTechnicalSummary(bar);
    const filename = `raw-${state.symbol}.json`;
    const evidence = $('selected-evidence');
    evidence.dataset.symbol = state.symbol;
    evidence.dataset.timestamp = bar ? String(bar.timestamp) : '';
    evidence.dataset.date = bar?.date || '';
    $('evidence-summary').textContent = bar ? `${state.symbol} · ${bar.date} · raw values & source` : 'No observation loaded';
    $('selected-date').textContent = bar?.date || '—';
    $('selected-date').dataset.timestamp = bar ? String(bar.timestamp) : '';
    $('evidence-state').textContent = bar ? `${state.symbol} · ${bar.date} · selected observation` : 'No observation loaded';
    $('evidence-reset').disabled = !bar || bar.timestamp === visibleBars().at(-1)?.timestamp;
    pairs($('evidence-values'), [['Timestamp (Unix seconds)', bar?.timestamp],
      ['Date basis', current()?.date_basis], ['Timezone', current()?.timezone],
      ['Open', bar?.open], ['High', bar?.high], ['Low', bar?.low], ['Close', bar?.close], ['Volume', bar?.volume]]);
    $('evidence-archive').textContent = raw(manifest?.id);
    $('evidence-file').textContent = manifest?.raw_sha256?.[filename] ? filename : 'Unknown';
    $('evidence-hash').textContent = raw(manifest?.raw_sha256?.[filename]);
    $('evidence-source').textContent = raw(manifest?.request_urls?.[state.symbol]);
    $('evidence-json').textContent = bar ? JSON.stringify(bar, null, 2) : 'No observation loaded';
    const technicals = visibleTechnicals(), index = visibleBars().indexOf(bar);
    const contract = current()?.technicals;
    $('evidence-indicator-status').textContent = Object.values(technicals).some(Boolean)
      ? `Backend v${contract.version} · ${contract.basis} · whole-archive warm-up`
      : 'Unavailable · backend did not return supported aligned indicators.';
    indicatorPairs($('evidence-indicator-values'), technicals, index);
    $('evidence-indicator-json').textContent = JSON.stringify({ timestamp: bar?.timestamp ?? null,
      version: contract?.version ?? null, basis: contract?.basis ?? null,
      values: Object.fromEntries(Object.keys(INDICATORS).map(key => [key, technicals[key]?.[index] ?? null])),
      unavailable_series: Object.keys(INDICATORS).filter(key => !technicals[key]) }, null, 2);
    const table = node('table'), head = node('thead'), labels = node('tr'), body = node('tbody'), values = node('tr');
    table.append(node('caption', bar ? `Selected observation · ${bar.date} · exact stored values` : 'Selected observation · no archive'));
    for (const field of ['date', 'open', 'high', 'low', 'close', 'volume']) {
      const label = node('th', field[0].toUpperCase() + field.slice(1)); label.scope = 'col'; labels.append(label);
      const cell = node('td', raw(bar?.[field])); cell.dataset.testid = `price-${field}`; values.append(cell);
    }
    head.append(labels); body.append(values); table.append(head, body); $('price-cards').replaceChildren(table);
    for (const id of ['observations-body', 'prices-body']) {
      $(id).querySelectorAll('tr[data-timestamp]').forEach(row => {
        const selected = !!bar && row.dataset.timestamp === String(bar.timestamp);
        row.classList.toggle('selected', selected);
        row.dataset.selected = String(selected);
        if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
        const button = row.querySelector('button');
        button.setAttribute('aria-pressed', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
    }
    restoreInspection();
    syncBacktest();
    updateCopilotControls();
  }
  function selectBar(index, announce = true) {
    const bars = visibleBars();
    if (!bars.length) return;
    const bar = bars[Math.max(0, Math.min(bars.length - 1, index))];
    state.selectedTimestamps[state.symbol] = bar.timestamp;
    renderSelection();
    inspectBar(bars.indexOf(bar), announce);
    for (const id of ['observations-body', 'prices-body']) {
      const row = $(id).querySelector('tr.selected'), scroller = $(id).closest('.observation-scroll, .table-scroll');
      if (!row || !scroller || scroller.closest('[hidden]')) continue;
      const bounds = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect();
      if (rect.top < bounds.top + 32) scroller.scrollTop += rect.top - bounds.top - 32;
      else if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
    }
  }
  function observationRow(bar, fields, testid) {
    const row = node('tr');
    row.dataset.timestamp = String(bar.timestamp); row.dataset.date = bar.date;
    if (testid) row.dataset.testid = testid;
    for (const field of fields) {
      const cell = node('td');
      if (field === 'date') {
        const button = node('button', bar.date, 'date-button'); button.type = 'button';
        button.setAttribute('aria-label', `Inspect ${state.symbol} ${bar.date}`); cell.append(button);
      } else {
        cell.textContent = testid && field === 'close' ? price(bar[field]) : raw(bar[field]);
        cell.title = raw(bar[field]);
      }
      row.append(cell);
    }
    row.addEventListener('click', () => {
      selectBar(visibleBars().findIndex(item => item.timestamp === bar.timestamp));
      row.querySelector('button').focus({ preventScroll: true });
    });
    return row;
  }
  function renderObservations() {
    const bars = visibleBars(), body = $('observations-body'); body.replaceChildren();
    $('observation-count').textContent = `${bars.length} records`;
    $('observation-context').textContent = `${state.symbol} / ${state.period} · newest first · select a date`;
    const fragment = document.createDocumentFragment();
    for (const bar of [...bars].reverse()) fragment.append(observationRow(bar, ['date', 'close', 'volume'], 'observation-row'));
    if (!bars.length) {
      const row = node('tr'), cell = node('td', state.marketBusy ? 'Reading archive…' : 'No archived observations.');
      cell.colSpan = 3; row.append(cell); fragment.append(row);
    }
    body.append(fragment);
  }

  const svgNode = (tag, attrs = {}, text) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  };
  let plot = null;
  function renderChart() {
    const svg = $('price-chart'), bars = visibleBars(), technicals = visibleTechnicals();
    state.hoverIndex = null;
    plot = null;
    $('chart-tooltip').hidden = true;
    $('chart-tooltip').replaceChildren();
    delete $('chart-tooltip').dataset.date;
    delete $('chart-tooltip').dataset.timestamp;
    svg.replaceChildren();
    svg.dataset.symbol = state.symbol;
    svg.dataset.bars = String(bars.length);
    svg.dataset.mode = state.chartMode;
    svg.dataset.interval = '1D';
    svg.dataset.selectedTimestamp = '';
    svg.dataset.selectedDate = '';
    delete svg.dataset.priceMin;
    delete svg.dataset.priceMax;
    svg.setAttribute('aria-label', `${state.symbol} ${state.period} daily ${state.chartMode === 'candles' ? 'OHLC candle' : 'closing price line'} chart, ${bars.length} actual bars${state.volume ? ', volume' : ''}${state.rsi14 ? ', RSI14' : ''}. Use Left and Right arrow keys to inspect observations.`);
    $('chart-host').hidden = !bars.length;
    $('chart-empty').hidden = !!bars.length;
    $('bar-count').textContent = `· ${bars.length} actual bars`;
    $('chart-range').textContent = bars.length ? `${bars[0].date} — ${bars.at(-1).date}` : 'No archive loaded';
    $('price-legend').replaceChildren(...(state.chartMode === 'candles'
      ? [node('span', '↑ Close > open', 'positive'), node('span', '↓ Close < open', 'negative'), node('span', '— Equal / doji')]
      : [node('span', 'Daily close', 'close-key')]));
    const missing = Object.keys(INDICATORS).filter(key => !technicals[key]);
    const gaps = Object.keys(INDICATORS).filter(key => technicals[key] && !technicals[key].some(numeric));
    $('technical-status').textContent = !bars.length ? 'Indicators unavailable · no archive loaded.'
      : [missing.length ? `${missing.map(key => INDICATORS[key]).join(' / ')} unavailable · backend series absent or unsupported.` : 'Backend v1 · provider_close · whole-archive warm-up.',
        gaps.length ? `${gaps.map(key => INDICATORS[key]).join(' / ')} unavailable in this window · warm-up / gaps.` : 'Nulls remain gaps.'].join(' ');
    if (!bars.length) return;

    // Coordinate transforms only: OHLCV and indicator values remain backend-owned.
    const width = Math.max(340, $('chart-host').clientWidth || 900);
    const height = Math.max(360, svg.clientHeight || 410);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const left = 18, right = width - 76, top = 22, bottom = height - 30;
    const paneGap = 22, volumeHeight = state.volume ? 55 : 0, rsiHeight = state.rsi14 ? 70 : 0;
    const priceBottom = bottom - volumeHeight - rsiHeight - (state.volume ? paneGap : 0) - (state.rsi14 ? paneGap : 0);
    const volumeTop = priceBottom + paneGap, volumeBottom = volumeTop + volumeHeight;
    const rsiTop = (state.volume ? volumeBottom : priceBottom) + paneGap;
    const priceValues = bars.flatMap(bar => [Number(bar.open), Number(bar.high), Number(bar.low), Number(bar.close)]);
    for (const key of ['sma20', 'sma50']) if (state[key] && technicals[key]) {
      priceValues.push(...technicals[key].filter(numeric).map(Number));
    }
    let low = priceValues.reduce((a, b) => Math.min(a, b));
    let high = priceValues.reduce((a, b) => Math.max(a, b));
    const padding = (high - low) * .08 || Math.abs(high) * .01 || 1;
    low -= padding; high += padding;
    const slot = (right - left) / bars.length;
    const x = index => left + (index + .5) * slot;
    const y = value => priceBottom - (value - low) * (priceBottom - top) / (high - low);
    const candleWidth = Math.min(12, slot * .7);
    svg.dataset.priceMin = String(low); svg.dataset.priceMax = String(high);
    const pricePane = svgNode('g', { 'data-testid': 'price-pane' });
    svg.append(pricePane);
    for (let index = 0; index <= 4; index++) {
      const value = high - (high - low) * index / 4, yy = y(value);
      pricePane.append(svgNode('line', { x1: left, y1: yy, x2: right, y2: yy, class: 'chart-grid-line' }),
        svgNode('text', { x: right + 12, y: yy + 4, class: 'chart-axis-label' }, price(value)));
    }
    pricePane.append(svgNode('text', { x: left, y: top - 8, class: 'chart-axis-label' }, `Price · ${current()?.currency || 'USD'}`));
    const tickCount = Math.min(bars.length, width < 500 ? 3 : 5);
    const indices = new Set(Array.from({ length: tickCount }, (_, i) => Math.round(i * (bars.length - 1) / Math.max(1, tickCount - 1))));
    for (const index of indices) {
      const xx = x(index);
      svg.insertBefore(svgNode('line', { x1: xx, y1: top, x2: xx, y2: bottom, class: 'chart-grid-line' }), pricePane);
      svg.append(svgNode('text', { x: xx, y: height - 10, class: 'chart-axis-label',
          'text-anchor': index === 0 ? 'start' : index === bars.length - 1 ? 'end' : 'middle' }, bars[index].date));
    }
    const direction = bar => Number(bar.close) > Number(bar.open) ? 'up' : Number(bar.close) < Number(bar.open) ? 'down' : 'neutral';
    if (state.chartMode === 'line') {
      const points = bars.map((bar, index) => `${x(index)},${y(Number(bar.close))}`).join(' ');
      pricePane.append(svgNode('polyline', { points, class: 'chart-line', 'data-testid': 'price-line',
        'data-symbol': state.symbol, 'data-bars': bars.length }));
      pricePane.append(svgNode('circle', { cx: x(bars.length - 1), cy: y(Number(bars.at(-1).close)), r: 3, class: 'chart-point' }));
    } else bars.forEach((bar, index) => {
      const xx = x(index), openY = y(Number(bar.open)), closeY = y(Number(bar.close));
      const candle = svgNode('g', { class: `candle candle-${direction(bar)}`, 'data-testid': 'candle',
        'data-timestamp': bar.timestamp, 'data-open': bar.open, 'data-high': bar.high,
        'data-low': bar.low, 'data-close': bar.close, 'data-direction': direction(bar) });
      candle.append(svgNode('title', {}, `${bar.date} · O ${bar.open} · H ${bar.high} · L ${bar.low} · C ${bar.close}`),
        svgNode('line', { x1: xx, x2: xx, y1: y(Number(bar.high)), y2: y(Number(bar.low)), class: 'candle-wick' }));
      candle.append(direction(bar) === 'neutral'
        ? svgNode('line', { x1: xx - candleWidth / 2, x2: xx + candleWidth / 2, y1: closeY, y2: closeY, class: 'candle-doji' })
        : svgNode('rect', { x: xx - candleWidth / 2, y: Math.min(openY, closeY), width: candleWidth,
          height: Math.abs(openY - closeY), class: 'candle-body' }));
      pricePane.append(candle);
    });
    // Each null terminates a path segment. Isolated valid values get a round zero-length stroke.
    function indicatorPath(key, parent, coordinate) {
      const values = technicals[key];
      if (!state[key] || !values) return;
      let connected = false;
      const commands = values.map((value, index) => {
        if (!numeric(value)) { connected = false; return ''; }
        const point = `${x(index)},${coordinate(Number(value))}`;
        const command = connected ? `L${point}` : `M${point}l0,0`;
        connected = true; return command;
      });
      parent.append(svgNode('path', { d: commands.join(' '), class: `indicator-line ${key}-line`,
        'data-testid': `${key}-line`, 'data-values': JSON.stringify(values), 'data-bars': bars.length,
        'data-offset': current().bars.length - bars.length, 'data-basis': 'provider_close', 'data-version': '1' }));
    }
    indicatorPath('sma20', pricePane, y); indicatorPath('sma50', pricePane, y);
    if (state.volume) {
      const pane = svgNode('g', { 'data-testid': 'volume-pane' });
      const maximum = bars.reduce((value, bar) => Math.max(value, Number(bar.volume)), 0);
      pane.append(svgNode('text', { x: left, y: volumeTop - 7, class: 'chart-axis-label' }, 'Volume · shares'),
        svgNode('line', { x1: left, x2: right, y1: volumeBottom, y2: volumeBottom, class: 'chart-grid-line' }),
        svgNode('text', { x: right + 12, y: volumeTop + 4, class: 'chart-axis-label' }, maximum.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })),
        svgNode('text', { x: right + 12, y: volumeBottom + 4, class: 'chart-axis-label' }, '0'));
      bars.forEach((bar, index) => {
        const barHeight = maximum > 0 ? Number(bar.volume) / maximum * volumeHeight : 0;
        const mark = svgNode('rect', { x: x(index) - candleWidth / 2, y: volumeBottom - barHeight,
          width: candleWidth, height: barHeight, class: `volume-bar candle-${direction(bar)}`,
          'data-testid': 'volume-bar', 'data-timestamp': bar.timestamp, 'data-value': bar.volume });
        mark.append(svgNode('title', {}, `${bar.date} · Volume ${bar.volume}`)); pane.append(mark);
      });
      svg.append(pane);
    }
    if (state.rsi14) {
      const pane = svgNode('g', { 'data-testid': 'rsi-pane', 'data-min': '0', 'data-max': '100' });
      const rsiY = value => bottom - value / 100 * rsiHeight;
      pane.append(svgNode('text', { x: left, y: rsiTop - 7, class: 'chart-axis-label' }, 'RSI14 · 0–100'));
      for (const value of [0, 30, 70, 100]) {
        pane.append(svgNode('line', { x1: left, x2: right, y1: rsiY(value), y2: rsiY(value),
          class: value === 30 || value === 70 ? 'rsi-guide' : 'chart-grid-line', 'data-level': value }),
        svgNode('text', { x: right + 12, y: rsiY(value) + 4, class: 'chart-axis-label' }, value));
      }
      indicatorPath('rsi14', pane, rsiY);
      if (!technicals.rsi14 || !technicals.rsi14.some(numeric)) pane.append(svgNode('text', {
        x: (left + right) / 2, y: rsiY(50) + 4, 'text-anchor': 'middle', class: 'chart-axis-label'
      }, technicals.rsi14 ? 'RSI14 unavailable · warm-up / gaps' : 'RSI14 unavailable · backend'));
      svg.append(pane);
    }
    const crosshair = svgNode('g', { visibility: 'hidden', 'aria-hidden': 'true', 'data-testid': 'crosshair' });
    const vertical = svgNode('line', { class: 'chart-crosshair', y1: top, y2: bottom });
    const horizontal = svgNode('line', { class: 'chart-crosshair', x1: left, x2: right });
    const dot = svgNode('circle', { r: 5, class: 'chart-point' });
    crosshair.append(vertical, horizontal, dot); svg.append(crosshair);
    plot = { bars, technicals, width, height, left, right, slot, x, y, crosshair, vertical, horizontal, dot };
    restoreInspection();
  }

  function inspectBar(index, announce = false) {
    if (!plot) return;
    index = Math.max(0, Math.min(plot.bars.length - 1, index));
    state.hoverIndex = index;
    const bar = plot.bars[index], x = plot.x(index), y = plot.y(Number(bar.close));
    plot.crosshair.setAttribute('visibility', 'visible');
    plot.crosshair.dataset.timestamp = String(bar.timestamp);
    for (const key of ['x1', 'x2']) plot.vertical.setAttribute(key, x);
    for (const key of ['y1', 'y2']) plot.horizontal.setAttribute(key, y);
    plot.dot.setAttribute('cx', x); plot.dot.setAttribute('cy', y);
    const tooltip = $('chart-tooltip');
    tooltip.setAttribute('aria-live', announce ? 'polite' : 'off');
    tooltip.dataset.date = bar.date;
    tooltip.dataset.timestamp = String(bar.timestamp);
    tooltip.replaceChildren(node('strong', `${state.symbol} · ${bar.date}`));
    const values = node('dl');
    // Exact strings are shown here; only axis ticks and summary quotes are rounded.
    pairs(values, [['Open', bar.open], ['High', bar.high], ['Low', bar.low], ['Close', bar.close], ['Volume', bar.volume]]);
    tooltip.append(values);
    const derived = node('dl', undefined, 'tooltip-indicators');
    indicatorPairs(derived, plot.technicals, index);
    tooltip.append(node('span', 'Derived · backend values', 'tooltip-section'), derived);
    tooltip.style.left = x > plot.width / 2 ? '18px' : 'auto';
    tooltip.style.right = x > plot.width / 2 ? 'auto' : '18px';
    tooltip.hidden = false;
  }
  function restoreInspection() {
    if (plot) {
      const bar = selectedBar();
      const index = plot.bars.findIndex(item => item.timestamp === bar?.timestamp);
      if (index >= 0) inspectBar(index); else plot.crosshair.setAttribute('visibility', 'hidden');
      $('price-chart').dataset.selectedTimestamp = bar ? String(bar.timestamp) : '';
      $('price-chart').dataset.selectedDate = bar?.date || '';
      plot.crosshair.dataset.timestamp = bar ? String(bar.timestamp) : '';
    }
    $('chart-tooltip').hidden = true;
  }
  function pointerIndex(event) {
    if (!plot) return null;
    const svg = $('price-chart'), matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return Math.floor((point.x - plot.left) / plot.slot);
  }
  $('price-chart').addEventListener('pointermove', event => {
    const index = pointerIndex(event); if (index !== null) inspectBar(index);
  });
  $('price-chart').addEventListener('click', event => {
    const index = pointerIndex(event);
    if (index !== null) { selectBar(index); $('price-chart').focus({ preventScroll: true }); }
  });
  $('price-chart').addEventListener('pointerleave', restoreInspection);
  $('price-chart').addEventListener('focus', () => {
    const bar = selectedBar();
    if (bar) inspectBar(visibleBars().indexOf(bar), true);
  });
  $('price-chart').addEventListener('blur', restoreInspection);
  $('price-chart').addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]')) return;
    if (!plot || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter') { selectBar(state.hoverIndex ?? visibleBars().indexOf(selectedBar())); return; }
    const index = visibleBars().indexOf(selectedBar());
    selectBar(event.key === 'Home' ? 0 : ['End', 'Escape'].includes(event.key) ? plot.bars.length - 1
      : index + (event.key === 'ArrowRight' ? 1 : -1), true);
  });
  for (const id of ['observations-body', 'prices-body']) $(id).addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]')) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) return;
    if (!visibleBars().length) return;
    event.preventDefault();
    const index = visibleBars().indexOf(selectedBar());
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1
      : (event.key === 'ArrowDown' ? 1 : -1) * (id === 'observations-body' ? -1 : 1);
    selectBar(event.key === 'Home' ? 0 : ['End', 'Escape'].includes(event.key) ? visibleBars().length - 1 : index + step);
    $(id).querySelector('tr.selected button')?.focus({ preventScroll: true });
  });
  $('evidence-reset').addEventListener('click', () => selectBar(visibleBars().length - 1));

  function renderPrices() {
    const bars = visibleBars(), body = $('prices-body');
    body.replaceChildren();
    $('prices-caption').textContent = `${state.symbol} · ${state.period} · ${bars.length} actual records · exact stored precision`;
    if (!bars.length) {
      const row = node('tr'), cell = node('td', state.marketBusy ? 'Loading saved records…' : 'No readable archive. Use Fetch Yahoo data.');
      cell.colSpan = 6; row.append(cell); body.append(row); return;
    }
    const fragment = document.createDocumentFragment();
    for (const bar of bars) {
      fragment.append(observationRow(bar, ['date', 'open', 'high', 'low', 'close', 'volume']));
    }
    body.append(fragment);
  }

  async function loadMarket(fetchNew = false, requestedSymbols = null, requestedDates = null) {
    if (state.marketBusy) return;
    // Every GUI download must first review explicit dates in Assets.
    if (fetchNew && !requestedDates) { research?.show('assets'); return; }
    const fetchSymbols = requestedSymbols || (savedSymbols().length ? savedSymbols() : SYMBOLS);
    state.marketBusy = true;
    state.snapshot = null; // A failed verification must never leave stale prices presented as valid.
    state.verification = fetchNew ? 'Fetching…' : 'Verifying…';
    $('market-workspace').setAttribute('aria-busy', 'true');
    for (const id of ['fetch-market', 'verify-market', 'empty-fetch']) $(id).disabled = true;
    $('load-state').dataset.state = 'loading';
    $('load-state').textContent = fetchNew ? 'Fetching Yahoo daily bars and saving raw provider responses…'
      : 'Reading saved archive · verifying manifest and raw SHA256 bytes…';
    setError('market-error'); renderMarket();
    try {
      const snapshot = await api(fetchNew ? 'market.fetch' : 'market.show', fetchNew ? { symbols: fetchSymbols, ...requestedDates } : {});
      if (!validSnapshot(snapshot)) throw fault('invalid_snapshot');
      state.snapshot = snapshot;
      if (!savedSymbols().includes(state.symbol)) state.symbol = savedSymbols()[0];
      state.verification = fetchNew ? 'Saved · verify with R' : 'Saved bytes verified';
      $('load-state').dataset.state = 'success';
      $('load-state').textContent = fetchNew
        ? 'Snapshot saved · select Verify saved data (R) to reread and verify saved bytes.'
        : 'Snapshot ready · saved manifest and raw bytes verified · no network fetch.';
      if (!tokenPersistence) $('load-state').textContent += ' Tab storage is unavailable; reopen the launcher URL after reload.';
    } catch (error) {
      state.snapshot = null;
      state.verification = 'No verified archive';
      $('load-state').dataset.state = 'error';
      $('load-state').textContent = 'No readable market snapshot. Fetch Yahoo data to create an archive. No replacement prices were loaded.';
      setError('market-error', message(error) + (fetchNew ? ' A failed fetch is not retried automatically; Verify saved data checks what was saved.' : ' Fetch explicitly to create a new archive.'));
    } finally {
      state.marketBusy = false;
      $('market-workspace').setAttribute('aria-busy', 'false');
      for (const id of ['fetch-market', 'verify-market', 'empty-fetch']) $(id).disabled = false;
      renderMarket();
    }
  }

  function invalidateBacktest() {
    research?.invalidateTrigger();
    backtest.revision++;
    backtest.reviewed = null;
    backtest.result = null;
    backtest.pages = { signals: 0, fills: 0, decisions: 0 };
    $('backtest-review').hidden = true;
    $('backtest-spec').textContent = '';
    $('backtest-results').hidden = true;
    for (const id of ['backtest-metrics', 'backtest-nav', 'backtest-drawdown', 'backtest-time-axis', 'backtest-performance-summary', 'backtest-signals',
      'backtest-fills', 'backtest-decisions', 'backtest-positions', 'backtest-contract', 'backtest-limitations',
      'backtest-result-source', 'backtest-equity-note', 'backtest-drawdown-note']) $(id).replaceChildren();
    $('portfolio-result-details').hidden = true;
    delete $('backtest-results').dataset.archiveId;
    delete $('backtest-results').dataset.symbol;
    delete $('backtest-results').dataset.symbols;
    delete $('backtest-results').dataset.mode;
    setError('backtest-error');
    $('backtest-status').textContent = 'Inputs changed. Review the active rules and settings before running.';
    updateBacktestControls();
  }
  // One authoritative source. Natural-language text is never interpreted locally.
  function activeRules() {
    if (backtest.ruleSource === 'natural') {
        if (!backtest.proposal || backtest.proposalQuestion !== $('criteria-question').value.trim()
          || !sameIdentity(backtest.proposalIdentity, selectedIdentity())) {
        throw new Error('Generate rules for the current description, or explicitly choose Build rules manually.');
      }
      return structuredClone(backtest.proposal);
    }
    if ($('criteria-advanced-enabled').checked) {
      let value;
      try { value = JSON.parse($('criteria-advanced-json').value); } catch { throw new Error('Invalid advanced criteria JSON syntax.'); }
      if (!value || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'entry') || !Object.hasOwn(value, 'exit')) {
        throw new Error('Advanced JSON must contain only entry and exit.');
      }
      return value;
    }
    const rule = kind => ({ left: $(`criteria-${kind}-left`).value, op: $(`criteria-${kind}-op`).value, right: $(`criteria-${kind}-right`).value.trim() });
    return { entry: rule('entry'), exit: rule('exit') };
  }
  function ruleDescription(value) {
    if (typeof value !== 'object' || value === null) return String(value);
    if (value.all) return `All of (${value.all.map(ruleDescription).join('; AND ')})`;
    if (value.any) return `Any of (${value.any.map(ruleDescription).join('; OR ')})`;
    if (value.not) return `NOT (${ruleDescription(value.not)})`;
    if (value.op) return `${ruleDescription(value.left)} ${{ gt: 'is greater than', lt: 'is less than', gte: 'is at least', lte: 'is at most', eq: 'equals', crosses_above: 'crosses above', crosses_below: 'crosses below' }[value.op]} ${ruleDescription(value.right)}`;
    if (value.operation) return `(${ruleDescription(value.left)} ${{ add: '+', subtract: '−', multiply: '×', divide: '÷' }[value.operation]} ${ruleDescription(value.right)})`;
    return `${value.indicator ? `${value.indicator.toUpperCase()}(${value.period} sessions)` : value.field}${value.lag ? `, ${value.lag} sessions ago` : ''}`;
  }
  function renderRuleSummary() {
    let rules;
    try { rules = activeRules(); } catch { $('criteria-summary').hidden = true; return; }
    if (!validCriterion(rules.entry) || !validCriterion(rules.exit)) { $('criteria-summary').hidden = true; return; }
    $('criteria-summary').hidden = false;
    $('criteria-source-status').textContent = backtest.ruleSource === 'natural' ? 'Active source: generated proposal for the current description · not validated performance.'
      : $('criteria-advanced-enabled').checked ? 'Active source: manual JSON. Simple controls are disabled; they do not override JSON.' : 'Active source: manual simple rules. JSON is inactive.';
    pairs($('criteria-summary-rules'), [
      ['Buy', `${ruleDescription(rules.entry)}. Entry applies only when exit is false and both criteria are available.`],
      ['Sell', `${ruleDescription(rules.exit)}. Exit takes precedence over entry.`],
      ['Hold', 'Neither condition is true. If either condition is unavailable, no trade occurs. Close-based signals use the next saved open; allocation modes trade only on their rebalance schedule.'],
    ]);
  }
  function selectRuleSource(source) {
    backtest.ruleSource = source;
    invalidateBacktest();
    $('criteria-generation-status').textContent = 'Generate rules for this description, then review settings. Nothing runs automatically.';
  }
  const portfolioMode = () => ['portfolio', 'dynamic'].includes($('backtest-mode').value);
  const backtestBars = () => (portfolioMode()
    ? state.snapshot?.symbols.find(item => numeric($(`portfolio-weight-${item.symbol}`)?.value)
      && Number($(`portfolio-weight-${item.symbol}`).value) > 0) || state.snapshot?.symbols[0] : current())?.bars || [];
  function updateBacktestMode() {
    const portfolio = portfolioMode();
    for (const tab of document.querySelectorAll('[data-backtest-mode]')) {
      const active = tab.dataset.backtestMode === $('backtest-mode').value;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      if (active) $('backtest-form').setAttribute('aria-labelledby', tab.id);
    }
    $('portfolio-fields').hidden = !portfolio;
    $('portfolio-fields').disabled = !portfolio;
    $('backtest-symbol-field').hidden = portfolio;
    $('dynamic-fields').hidden = $('backtest-mode').value !== 'dynamic';
    for (const input of $('dynamic-fields').querySelectorAll('input')) input.disabled = $('backtest-mode').value !== 'dynamic';
    $('portfolio-rebalance').disabled = !portfolio || $('portfolio-calendar').value !== 'sessions';
    $('backtest-mode-note').textContent = portfolio
      ? 'Portfolio price-return simulation, not point-in-time (PIT) verification or dividend total return. Shared close-based criteria update eligibility daily; exit takes precedence. Rebalance on the selected session, monthly or quarterly schedule. Close-time target quantities fill at the next saved open: sells first, then alphabetical cash-limited buys. Unfilled quantities expire; unavailable criteria preserve holdings. Momentum selects the top N positive trailing returns above the minimum threshold, or holds cash if none qualify. Long-only integer units; no final-day liquidation or real orders.'
      : 'Price-return simulation, not point-in-time (PIT) verification or dividend total return. Close-based criteria fill at the next observed open within the window. Buy integer units with available cash; exit takes precedence. Unavailable criteria mean no trades. No final-day liquidation or real orders.';
  }
  function syncBacktest() {
    research?.syncArchive();
    const identity = selectedIdentity();
    const source = identity ? `${identity.archiveId}:${portfolioMode() ? 'portfolio' : identity.symbol}` : null;
    const selection = identity ? `${source}:${identity.symbol}:${identity.timestamp}` : null;
    if (source !== backtest.source) {
      backtest.source = source;
      const bars = backtestBars();
      $('backtest-symbol').replaceChildren(...savedSymbols().map(symbol => { const option = node('option', symbol); option.value = symbol; return option; }));
      $('backtest-symbol').value = state.symbol;
      $('backtest-archive').value = state.snapshot?.manifest?.id || '';
      for (const id of ['backtest-start', 'backtest-end']) {
        $(id).replaceChildren(...bars.map(bar => {
          const option = node('option', bar.date); option.value = bar.date; return option;
        }));
      }
      $('backtest-start').value = bars[Math.max(0, bars.length - 126)]?.date || '';
      $('backtest-end').value = bars.at(-1)?.date || '';
    }
    $('backtest-symbol').value = state.symbol;
    if (selection !== backtest.selection) {
      backtest.selection = selection;
      if (!sameIdentity(backtest.proposalIdentity, identity)) {
        backtest.proposal = null; backtest.proposalQuestion = null;
        $('criteria-explanation').hidden = true;
      }
      invalidateBacktest();
      $('criteria-generation-status').textContent = 'Selection changed. Check the pinned source and model before generating criteria.';
    }
    updateBacktestControls();
  }
  function updateBacktestControls() {
    const available = !!backtest.source && !state.marketBusy && !!token && backtestBars().length >= 2;
    const manual = backtest.ruleSource === 'manual';
    const readyRules = manual || !!backtest.proposal && backtest.proposalQuestion === $('criteria-question').value.trim()
      && sameIdentity(backtest.proposalIdentity, selectedIdentity());
    $('criteria-natural').hidden = manual;
    $('criteria-manual').hidden = !manual;
    $('criteria-source-natural').setAttribute('aria-pressed', String(!manual));
    $('criteria-source-manual').setAttribute('aria-pressed', String(manual));
    $('criteria-simple-fields').disabled = !manual || $('criteria-advanced-enabled').checked;
    $('criteria-advanced-json').disabled = !manual || !$('criteria-advanced-enabled').checked;
    $('criteria-advanced-enabled').disabled = !manual;
    $('criteria-copy-simple').disabled = !manual;
    $('backtest-preview').disabled = !available || !readyRules || backtest.busy || backtest.generating;
    $('backtest-run').disabled = !available || !readyRules || backtest.busy || backtest.generating || !backtest.reviewed;
    const question = $('criteria-question').value.trim();
    $('criteria-generate').disabled = manual || !available || copilot.busy || backtest.busy || backtest.generating || !copilot.ready || copilot.blocked
      || !sameIdentity(copilot.identity, selectedIdentity()) || !question || question.length > 4000
      || !copilot.models.some(model => model.id === $('copilot-model').value);
    $('backtest-panel').setAttribute('aria-busy', String(backtest.busy || backtest.generating));
    $('criteria-generate').textContent = backtest.generating ? 'Generating rules…' : backtest.proposal ? 'Regenerate rules' : 'Generate rules';
    $('criteria-generation-help').textContent = !copilot.ready ? 'AI generation is unavailable until a model is configured in Settings. Build rules manually works without AI.'
      : !available ? 'Load saved market data before generating rules. No substitute prices are used.'
      : !sameIdentity(copilot.identity, selectedIdentity()) ? 'The pinned Copilot source differs. Use current selection in the permanent chat, then generate again.'
      : 'Generate sends your description and pinned saved public data to the selected model. Review the proposed rules below; weights, dates and costs stay under your control. Nothing runs automatically.';
    renderRuleSummary();
  }
  // Same bounded decimal transport as HTTP. Exact units avoid accepting rounded weight sums.
  const validDecimal = value => typeof value === 'string' && value.length <= 64 && DECIMAL.test(value)
    && Math.abs(Number(value.split(/[eE]/)[1] || 0)) <= 100;
  const DECIMAL_UNIT = 10n ** 164n;
  function decimalUnits(value) {
    const [mantissa, exponent = '0'] = value.split(/[eE]/);
    const fraction = mantissa.split('.')[1]?.length || 0;
    return BigInt(mantissa.replace('.', '')) * 10n ** BigInt(164 + Number(exponent) - fraction);
  }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function criteriaSpec() {
    const rules = activeRules();
    const spec = { archive_id: state.snapshot?.manifest?.id, symbol: state.symbol,
      start: $('backtest-start').value, end: $('backtest-end').value,
      initial_cash: $('backtest-cash').value.trim(), fee_bps: $('backtest-fee').value.trim(),
      slippage_bps: $('backtest-slippage').value.trim(), entry: rules.entry, exit: rules.exit };
    if (portfolioMode()) {
      delete spec.symbol;
      const weightsInput = savedSymbols().map(symbol => [symbol, $(`portfolio-weight-${symbol}`).value.trim()]);
      if (weightsInput.some(([, value]) => !validDecimal(value))) throw new Error('All weights must be decimal strings.');
      spec.weights = Object.fromEntries(weightsInput.filter(([, value]) => decimalUnits(value) !== 0n));
      spec.rebalance_every = $('portfolio-calendar').value === 'sessions' ? Number($('portfolio-rebalance').value) : 1;
      // Explicit defaults match the backend's serialized spec and are visible during review.
      spec.rebalance_calendar = $('portfolio-calendar').value;
      spec.allocation = { mode: 'fixed', lookback: 20, top_n: 1, minimum_return: '0' };
      if ($('backtest-mode').value === 'dynamic') {
        spec.allocation = { mode: 'momentum', lookback: Number($('dynamic-lookback').value),
          top_n: Number($('dynamic-top-n').value), minimum_return: $('dynamic-min-return').value.trim() };
        if (!Number.isInteger(spec.allocation.lookback) || spec.allocation.lookback < 1 || spec.allocation.lookback > 252
          || !Number.isInteger(spec.allocation.top_n) || spec.allocation.top_n < 1 || spec.allocation.top_n > Object.keys(spec.weights).length
          || !validDecimal(spec.allocation.minimum_return)) throw new Error('Momentum lookback must be 1–252, top N a positive integer no greater than the selected asset count, and minimum return a decimal.');
      }
      if (Object.values(spec.weights).some(value => !validDecimal(value))) {
        throw new Error('Weights must be decimal strings up to 64 characters, with exponents from −100 to 100.');
      }
      const weights = Object.values(spec.weights).map(decimalUnits), total = weights.reduce((sum, value) => sum + value, 0n);
      if (weights.some(value => value < 0n || value > DECIMAL_UNIT) || total <= 0n || total > DECIMAL_UNIT) {
        throw new Error('Each weight must be 0–1, with an exact sum greater than 0 and at most 1. Weights are not adjusted automatically.');
      }
      if (!Number.isSafeInteger(spec.rebalance_every) || spec.rebalance_every < 1 || spec.rebalance_every > 100000) {
        throw new Error('Rebalance interval must be an integer from 1 to 100000 saved sessions.');
      }
    }
    const dates = backtestBars().map(bar => bar.date);
    if (!backtest.source || state.marketBusy || !dates.includes(spec.start) || !dates.includes(spec.end)
      || spec.start >= spec.end) throw new Error('Select distinct saved sessions with start before end. Dates are not shifted automatically.');
    if (!validDecimal(spec.initial_cash) || decimalUnits(spec.initial_cash) <= 0n
      || ['fee_bps', 'slippage_bps'].some(key => !validDecimal(spec[key]) || decimalUnits(spec[key]) < 0n || decimalUnits(spec[key]) >= 10000n * DECIMAL_UNIT)) {
      throw new Error('Cash must be positive; fees and slippage must be at least 0 and below 10000 bps. Decimal inputs allow up to 64 characters and exponents from −100 to 100.');
    }
    if (!validCriterion(spec.entry) || !validCriterion(spec.exit)) {
      throw new Error('Unsupported criteria format or complexity. Check operands, comparisons, all / any / not structures and limits in the shared schema. The left operand cannot be a numeric constant. Use {field:"volume"} for volume, not a string.');
    }
    const explicitLags = value => {
      if (Array.isArray(value)) return value.map(explicitLags);
      if (!object(value)) return value;
      const normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, explicitLags(item)]));
      if (Object.hasOwn(value, 'indicator') || Object.hasOwn(value, 'field')) normalized.lag ??= 0;
      return normalized;
    };
    spec.entry = explicitLags(spec.entry); spec.exit = explicitLags(spec.exit);
    return spec;
  }
  function previewBacktest(event) {
    event.preventDefault();
    if ($('backtest-preview').disabled) return;
    invalidateBacktest();
    try {
      const spec = criteriaSpec();
      backtest.reviewed = JSON.stringify(spec);
      $('backtest-spec').textContent = JSON.stringify(spec, null, 2);
      $('backtest-review').hidden = false;
      $('backtest-review-summary').textContent = `${$('backtest-mode').selectedOptions[0].textContent} · ${spec.symbol || Object.entries(spec.weights).map(([symbol, weight]) => `${symbol}: ${weight}`).join(', ')} · ${spec.start} — ${spec.end} · Initial cash ${spec.initial_cash} USD · Fee ${spec.fee_bps} bps · Slippage ${spec.slippage_bps} bps. ${spec.allocation ? `Allocation: ${spec.allocation.mode}; rebalance every ${spec.rebalance_every} ${spec.rebalance_calendar}. ${spec.allocation.mode === 'momentum' ? `Lookback ${spec.allocation.lookback}, top ${spec.allocation.top_n}, minimum return ${spec.allocation.minimum_return}.` : ''} Benchmark: same-weight buy once.` : 'Benchmark: buy and hold.'} Same dates and costs; price returns, not PIT or dividend total returns.`;
      $('backtest-status').textContent = 'Run backtest sends this exact JSON to Python for validation, signal generation and simulation.';
    } catch (error) { setError('backtest-error', error.message); }
    updateBacktestControls();
  }
  function backtestTableRow(body, values) {
    const row = node('tr');
    for (const value of values) row.append(node('td', raw(value)));
    body.append(row); return row;
  }
  // Presentation transform only: drawdown is derived from returned daily NAV, never from prices.
  // A missing NAV makes the subsequent running peak unknown: no fabricated continuation.
  function performancePlot(svg, result, drawdown, dates, { left, right, top, bottom }, x) {
    svg.replaceChildren();
    const note = $(drawdown ? 'backtest-drawdown-note' : 'backtest-equity-note');
    const series = ['strategy', 'benchmark'].map(key => {
      const portfolio = result[key], daily = Array.isArray(portfolio?.daily) ? portfolio.daily : [];
      let peak = numeric(portfolio?.metrics?.initial_cash) && Number(portfolio.metrics.initial_cash) > 0
        ? Number(portfolio.metrics.initial_cash) : null;
      return { key, points: dates.map(date => {
        const matches = daily.filter(row => row.date === date), row = matches.length === 1 ? matches[0] : null;
        let value = row && numeric(row.nav) && Number(row.nav) >= 0 ? Number(row.nav) : null;
        if (drawdown) {
          if (value === null || peak === null) { value = null; peak = null; }
          else { peak = Math.max(peak, value); value = 100 * (value / peak - 1); }
        }
        return { date, value, nav: row?.nav };
      }) };
    });
    const values = series.flatMap(item => item.points.map(point => point.value).filter(value => value !== null));
    svg.dataset.points = String(values.length);
    if (!values.length || !dates.length) {
      svg.append(svgNode('text', { x: left, y: top + 20, class: 'chart-axis-label' }, `${drawdown ? 'Daily drawdown' : 'Daily NAV'} unavailable · no substitute curve`));
      note.textContent = `${drawdown ? 'Drawdown' : 'NAV'} unavailable.`;
      return;
    }
    let min = Math.min(...values), max = Math.max(...values);
    if (drawdown) max = 0;
    const span = max - min || Math.max(1, Math.abs(max) * 0.01);
    min -= span * 0.06;
    if (!drawdown) max += span * 0.06;
    svg.dataset.axisMin = String(min); svg.dataset.axisMax = String(max);
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    svg.append(svgNode('text', { x: left, y: top - 10, class: 'chart-axis-label performance-lane-label' }, drawdown ? 'Daily drawdown (%)' : 'Daily NAV (USD)'));
    const ticks = drawdown ? 2 : 3;
    for (let i = 0; i <= ticks; i++) {
      const value = min + (max - min) * i / ticks;
      svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'chart-grid-line' }),
        svgNode('text', { x: left - 7, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-axis-label' }, `${price(value)}${drawdown ? '%' : ''}`));
    }
    for (const item of series) {
      let path = '', connected = false;
      item.points.forEach((point, index) => {
        if (point.value === null) { connected = false; return; }
        path += `${connected ? 'L' : 'M'}${x(index)},${y(point.value)} `;
        connected = true;
        const isolated = item.points[index - 1]?.value == null && item.points[index + 1]?.value == null;
        const radius = dates.length > 1 ? Math.min(3, (right - left) / (dates.length - 1) * 0.45) : 3;
        const dot = svgNode('circle', { cx: x(index), cy: y(point.value), r: radius,
          class: `backtest-point ${item.key}${isolated ? ' only-point' : ''}`, 'data-date': point.date,
          'data-value': drawdown ? point.value : point.nav, 'data-portfolio': item.key });
        dot.append(svgNode('title', {}, `${item.key} · ${point.date} · ${drawdown ? `${point.value}%` : point.nav}`));
        svg.append(dot);
      });
      svg.prepend(svgNode('path', { d: path, class: `backtest-line ${item.key}`, 'data-portfolio': item.key }));
    }
    note.textContent = `${values.length} valid ${drawdown ? 'drawdown' : 'NAV'} points${values.length < dates.length * 2 ? ' · gaps retained' : ''}.`;
  }
  function renderPerformanceChart() {
    const result = backtest.result, svg = $('backtest-equity');
    const width = svg.getBoundingClientRect().width;
    if (!result || !width) return; // Hidden workspaces are redrawn when their measured size returns.
    const height = 300, left = 80, right = width - 16;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const dates = [...new Set(['strategy', 'benchmark'].flatMap(key =>
      Array.isArray(result[key]?.daily) ? result[key].daily.map(row => row.date).filter(date => typeof date === 'string') : []))].sort();
    const x = index => left + (dates.length === 1 ? 0 : index / (dates.length - 1)) * (right - left);
    performancePlot($('backtest-nav'), result, false, dates, { left, right, top: 28, bottom: 157 }, x);
    performancePlot($('backtest-drawdown'), result, true, dates, { left, right, top: 197, bottom: 268 }, x);
    svg.dataset.points = $('backtest-nav').dataset.points;
    const axis = $('backtest-time-axis'); axis.replaceChildren();
    if (dates.length) {
      const indices = [...new Set([0, ...(width >= 600 ? [Math.floor((dates.length - 1) / 2)] : []), dates.length - 1])];
      for (const index of indices) axis.append(svgNode('text', { x: x(index), y: 291,
        'text-anchor': index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle', class: 'chart-axis-label' }, dates[index]));
    }
  }
  new ResizeObserver(renderPerformanceChart).observe($('backtest-equity'));

  function renderPerformanceSummary(result) {
    const summary = $('backtest-performance-summary'); summary.replaceChildren();
    for (const key of ['strategy', 'benchmark']) {
      const card = node('div', undefined, `performance-summary ${key}`);
      card.append(node('strong', key === 'strategy' ? 'Strategy' : 'Benchmark'));
      for (const [metric, label] of [['cagr', 'CAGR'], ['max_drawdown', 'MDD']]) {
        const value = result[key]?.metrics?.[metric];
        const badge = node('span', `${label} ${resultPercent(value)}`, 'performance-metric');
        badge.dataset.portfolio = key; badge.dataset.metric = metric;
        badge.dataset.value = value == null ? 'null' : String(value);
        card.append(badge);
      }
      summary.append(card);
    }
  }
  const resultIsPortfolio = result => result?.contract?.version === 'portfolio-v1';
  const resultSymbols = result => resultIsPortfolio(result) ? result.symbols : [result.symbol];
  const resultPercent = value => numeric(value) ? `${price(Number(value) * 100)}%` : 'Unavailable';
  function pageRows(kind, rows) {
    const size = 20, pages = Math.max(1, Math.ceil(rows.length / size));
    backtest.pages[kind] = Math.max(0, Math.min(backtest.pages[kind], pages - 1));
    const page = backtest.pages[kind];
    $(`backtest-${kind}-prev`).disabled = page === 0;
    $(`backtest-${kind}-next`).disabled = page === pages - 1;
    $(`backtest-${kind}-page`).textContent = rows.length
      ? `${page * size + 1}–${Math.min(rows.length, (page + 1) * size)} / ${rows.length} records · oldest first` : '0 records';
    return rows.slice(page * size, (page + 1) * size);
  }
  function renderBacktestSignals() {
    const result = backtest.result;
    if (!result) return;
    const symbol = $('backtest-signal-symbol').value, portfolio = resultIsPortfolio(result);
    const signals = portfolio ? result.signals?.[symbol] : result.signals;
    $('backtest-signals').replaceChildren();
    $('backtest-signal-note').textContent = portfolio
      ? `${symbol} · Signals change eligibility only, not immediate orders. Fill dates follow rebalance decisions.`
      : `${symbol} · Close-based criteria can fill at the next observed open within the window.`;
    for (const signal of pageRows('signals', Array.isArray(signals) ? signals : [])) {
      const timing = portfolio
        ? signal.next_execution_date ? 'Fills only on rebalance schedule · see decisions' : 'End of window · no fill'
        : `${raw(signal.next_execution_date)} · ${raw(signal.execution_reason)}`;
      const row = backtestTableRow($('backtest-signals'), [signal.date, `${raw(signal.status)} · ${raw(signal.reason)}`, '', '', timing]);
      row.dataset.symbol = symbol; row.dataset.date = signal.date; row.dataset.status = signal.status;
      for (const [index, rule] of [[2, signal.entry_reason], [3, signal.exit_reason]]) {
        const cell = row.children[index]; cell.dataset.reason = JSON.stringify(rule ?? null);
        if (!rule) { cell.textContent = 'Unavailable'; continue; }
        if (!Object.hasOwn(rule, 'left') || object(rule.left) || object(rule.right)) {
          const detail = node('details', undefined, 'criterion-values');
          detail.append(node('summary', 'Structured criteria · original backend evaluation'), node('pre', JSON.stringify(rule, null, 2)));
          cell.append(detail); continue;
        }
        cell.append(node('span', `${raw(rule.left)} ${raw(rule.op)} ${raw(rule.right)}`),
          node('div', `${raw(rule.result)} · ${raw(rule.reason)}`));
        const detail = node('details', undefined, 'criterion-values');
        detail.append(node('summary', 'Exact operand values'), node('pre',
          `Current: ${raw(rule.left_value)} / ${raw(rule.right_value)}\n`
          + `Previous (${raw(rule.previous_date)}): ${raw(rule.previous_left_value)} / ${raw(rule.previous_right_value)}`));
        cell.append(detail);
      }
    }
    if (!$('backtest-signals').children.length) backtestTableRow($('backtest-signals'), ['Unavailable · no backend signals']);
  }
  function renderBacktestFills() {
    const result = backtest.result;
    if (!result) return;
    const rows = ['strategy', 'benchmark'].flatMap(book => (result[book]?.fills || []).map(fill => ({ book, fill })))
      .sort((a, b) => a.fill.date.localeCompare(b.fill.date));
    $('backtest-fills').replaceChildren();
    for (const { book, fill } of pageRows('fills', rows)) {
      const symbol = fill.symbol ?? result.symbol;
      const row = backtestTableRow($('backtest-fills'), [book, fill.signal_date, fill.date, fill.side, fill.quantity,
        fill.open, fill.price, fill.fee, fill.slippage_cost, symbol]);
      row.dataset.portfolio = book; row.dataset.symbol = symbol;
      row.dataset.signalDate = fill.signal_date; row.dataset.fillDate = fill.date;
      if (fill.decision_id !== undefined) row.dataset.decisionId = String(fill.decision_id);
    }
    if (!rows.length) backtestTableRow($('backtest-fills'), ['Strategy / benchmark', 'No fills returned']);
  }
  function renderPortfolioPositions() {
    const result = backtest.result;
    if (!resultIsPortfolio(result)) return;
    const book = $('portfolio-result-book').value;
    const daily = result[book].daily.find(row => row.date === $('portfolio-position-date').value);
    $('backtest-positions').replaceChildren();
    $('portfolio-position-summary').textContent = daily
      ? `${book === 'strategy' ? 'Strategy' : 'Benchmark'} · NAV ${price(daily.nav)} USD · Cash ${price(daily.cash)} (${resultPercent(daily.cash_weight)})` : 'No holdings records';
    if (!daily) return;
    for (const symbol of result.symbols) {
      const row = backtestTableRow($('backtest-positions'), [symbol, daily.positions[symbol], price(daily.market_values[symbol]),
        resultPercent(daily.weights[symbol]), resultPercent(result.spec.weights[symbol])]);
      row.dataset.symbol = symbol; row.dataset.date = daily.date; row.dataset.portfolio = book;
      row.children[2].dataset.value = daily.market_values[symbol]; row.children[3].dataset.value = daily.weights[symbol];
    }
  }
  function renderPortfolioDecisions() {
    const result = backtest.result;
    if (!resultIsPortfolio(result)) return;
    const book = $('portfolio-result-book').value, portfolio = result[book];
    const rows = portfolio.decisions.flatMap(decision => result.symbols.map(symbol => ({ decision, symbol })));
    $('backtest-decisions').replaceChildren();
    for (const { decision, symbol } of pageRows('decisions', rows)) {
      const order = portfolio.orders.find(item => item.decision_id === decision.decision_id && item.symbol === symbol);
      const outcome = order
        ? `${order.side}: ${order.filled_quantity}/${order.requested_quantity} · ${order.status}`
          + (order.reason ? ` · ${order.reason}` : '') : 'No quantity change · no order';
      const row = backtestTableRow($('backtest-decisions'), [`#${decision.decision_id} · ${decision.date} → ${decision.next_execution_date}`,
        symbol, decision.eligible[symbol], decision.targets[symbol], decision.reasons[symbol], outcome]);
      row.dataset.decisionId = String(decision.decision_id); row.dataset.symbol = symbol; row.dataset.portfolio = book;
      row.dataset.date = decision.date; row.dataset.executionDate = decision.next_execution_date;
      row.children[3].title = `NAV at decision ${decision.nav}; ${symbol} close ${decision.close_prices[symbol]}`;
      row.children[5].dataset.order = JSON.stringify(order ?? null);
    }
    if (!rows.length) backtestTableRow($('backtest-decisions'), ['No rebalance decisions returned.']);
  }
  function syncPortfolioBook() {
    const result = backtest.result;
    if (!resultIsPortfolio(result)) return;
    const previousDate = $('portfolio-position-date').value, daily = result[$('portfolio-result-book').value].daily;
    $('portfolio-position-date').replaceChildren(...daily.map(row => { const option = node('option', row.date); option.value = row.date; return option; }));
    $('portfolio-position-date').value = daily.some(row => row.date === previousDate) ? previousDate : daily.at(-1)?.date || '';
    backtest.pages.decisions = 0;
    renderPortfolioDecisions(); renderPortfolioPositions();
  }
  function renderBacktest(result) {
    backtest.result = result;
    backtest.pages = { signals: 0, fills: 0, decisions: 0 };
    const portfolio = resultIsPortfolio(result);
    const percent = value => numeric(value) ? `${price(Number(value) * 100)}%` : 'Unavailable';
    const portfolios = [result.strategy, result.benchmark];
    const slippage = portfolio => Array.isArray(portfolio?.fills) && portfolio.fills.every(fill => numeric(fill.slippage_cost))
      ? portfolio.fills.reduce((sum, fill) => sum + Number(fill.slippage_cost), 0) : null;
    for (const [label, get, format] of [
      ['Cumulative return', p => p?.metrics?.total_return, percent],
      ['CAGR · annualized return', p => p?.metrics?.cagr, percent],
      ['MDD · maximum drawdown', p => p?.metrics?.max_drawdown, percent],
      ['Final NAV', p => p?.metrics?.final_nav, price],
      ['Final cash', p => p?.metrics?.final_cash, price],
      ['Fees', p => p?.metrics?.fees, price],
      ['Slippage cost', p => portfolio ? p?.metrics?.slippage_cost : slippage(p), price],
      ['Fill count', p => p?.metrics?.fill_count, raw],
      ...(portfolio ? [
        ['Turnover · traded notional / initial cash', p => p?.metrics?.turnover, percent],
        ['Rebalance count', p => p?.metrics?.rebalance_count, raw],
      ] : []),
    ]) {
      const row = backtestTableRow($('backtest-metrics'), [label, ...portfolios.map(p => format(get(p)))]);
      portfolios.forEach((p, index) => { row.children[index + 1].dataset.value = raw(get(p)); });
    }
    $('backtest-result-title').textContent = portfolio ? 'Portfolio strategy and same-weight buy-once benchmark' : 'Strategy and buy-and-hold benchmark';
    $('backtest-result-source').textContent = `${resultSymbols(result).join(' / ')} · ${result.spec.start} — ${result.spec.end} · ${raw(result.contract?.currency)} · Archive ${result.archive_id}`
      + (portfolio ? ` · ${result.spec.allocation?.mode === 'momentum' ? 'Momentum ranking' : 'Fixed weights'} · ${result.spec.rebalance_calendar && result.spec.rebalance_calendar !== 'sessions' ? ({ monthly: 'Monthly', quarterly: 'Quarterly' }[result.spec.rebalance_calendar] || result.spec.rebalance_calendar) : `Every ${result.spec.rebalance_every} saved sessions`} · Weights ${Object.entries(result.spec.weights).map(([symbol, weight]) => `${symbol} ${percent(weight)}`).join(', ')}` : '');
    renderPerformanceSummary(result);
    $('backtest-signal-symbol').replaceChildren(...resultSymbols(result).map(symbol => {
      const option = node('option', symbol); option.value = symbol; return option;
    }));
    if (resultSymbols(result).includes(state.symbol)) $('backtest-signal-symbol').value = state.symbol;
    renderBacktestSignals(); renderBacktestFills();
    $('portfolio-result-details').hidden = !portfolio;
    if (portfolio) { $('portfolio-result-book').value = 'strategy'; $('portfolio-position-date').replaceChildren(); syncPortfolioBook(); }
    $('backtest-contract').textContent = JSON.stringify(result.contract ?? null, null, 2);
    for (const limitation of Array.isArray(result.limitations) ? result.limitations : ['Limitations unavailable']) {
      $('backtest-limitations').append(node('li', limitation));
    }
    $('backtest-results').dataset.archiveId = result.archive_id;
    $('backtest-results').dataset.mode = portfolio ? 'portfolio' : 'single';
    $('backtest-results').dataset.symbols = resultSymbols(result).join(',');
    if (!portfolio) $('backtest-results').dataset.symbol = result.symbol;
    else delete $('backtest-results').dataset.symbol;
    $('backtest-results').hidden = false;
    renderPerformanceChart();
  }
  async function runBacktest() {
    if ($('backtest-run').disabled) return;
    let spec;
    try {
      spec = criteriaSpec();
      if (JSON.stringify(spec) !== backtest.reviewed) { invalidateBacktest(); return; }
    } catch (error) { invalidateBacktest(); setError('backtest-error', error.message); return; }
    const revision = backtest.revision;
    const portfolio = Object.hasOwn(spec, 'weights');
    backtest.busy = true;
    backtest.result = null;
    $('backtest-results').hidden = true;
    for (const id of ['backtest-metrics', 'backtest-signals', 'backtest-fills', 'backtest-decisions', 'backtest-positions', 'backtest-limitations']) $(id).replaceChildren();
    setError('backtest-error');
    $('backtest-status').textContent = 'Verifying saved data → generating criteria signals → simulating next-open fills';
    updateBacktestControls();
    try {
      research.beginProgress(spec);
      const result = await streamApi(portfolio ? 'market.portfolio' : 'market.backtest', { spec }, research.progress);
      if (revision !== backtest.revision) { research.finishProgress('Complete · result discarded because inputs changed. Preview the new specification and run again.'); return; }
      const sameSpec = (a, b) => a === b || a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
        && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
        && Object.keys(a).every(key => Object.hasOwn(b, key) && sameSpec(a[key], b[key]));
      const symbols = portfolio ? Object.keys(spec.weights).sort() : [spec.symbol];
      if (!sameSpec(spec, result?.spec) || result.archive_id !== spec.archive_id
          || result.contract?.version !== (portfolio ? 'portfolio-v1' : 'criteria-v1')
          || (portfolio ? !Array.isArray(result.symbols) || result.symbols.join(',') !== symbols.join(',')
            || !result.signals || Object.keys(result.signals).length !== symbols.length
            || symbols.some(symbol => !Array.isArray(result.signals[symbol]))
            : result.symbol !== spec.symbol || !Array.isArray(result.signals))
          || ['strategy', 'benchmark'].some(key => !result[key]?.metrics || !Array.isArray(result[key].daily)
            || !Array.isArray(result[key].fills) || (portfolio && (!Array.isArray(result[key].decisions) || !Array.isArray(result[key].orders))))) {
        throw fault('invalid_response');
      }
      renderBacktest(result);
      research.finishProgress('Complete · final result validated');
      $('backtest-status').textContent = 'Complete · fills simulated from backend user-criteria signals. Price-return simulation only; no real orders or saved research bundle.';
    } catch (error) {
      research.finishProgress(`Failed · ${message(error)}`, true);
      if (revision !== backtest.revision) return;
      backtest.result = null;
      $('backtest-results').hidden = true;
      setError('backtest-error', message(error));
      $('backtest-status').textContent = 'No usable result. No substitute data or automatic retry. Verify saved data if the archive changed.';
    } finally { backtest.busy = false; updateBacktestControls(); }
  }
  async function generateCriteria() {
    updateBacktestControls();
    if ($('criteria-generate').disabled) return;
    const identity = copilot.identity, revision = backtest.revision;
    const request = { symbol: identity.symbol, timestamp: identity.timestamp, archiveId: identity.archiveId,
      model: $('copilot-model').value, question: $('criteria-question').value.trim() };
    backtest.generating = true; copilot.busy = true;
    $('criteria-generation-status').textContent = 'Generating structured entry and exit criteria · no backtest is running.';
    updateCopilotControls();
    try {
      const result = await api('copilot.criteria', request);
      if (revision !== backtest.revision || !sameIdentity(identity, selectedIdentity())) return;
      if (!sameIdentity(result?.contextIdentity, identity) || result?.scope !== 'saved_snapshot_only'
          || (result.model !== undefined && result.model !== request.model)) throw fault('invalid_response');
      const criteria = result.criteria;
      if (result.supported === false || !criteria || !validCriterion(criteria.entry) || !validCriterion(criteria.exit)) {
        throw fault('criteria_unsupported');
      }
      // Copy only validated criteria. Dates, costs, source, cash, weights and cadence stay user-owned.
      invalidateBacktest();
      backtest.proposal = structuredClone({ entry: criteria.entry, exit: criteria.exit });
      backtest.proposalQuestion = request.question;
      backtest.proposalIdentity = identity;
      $('criteria-advanced-json').value = JSON.stringify({ entry: criteria.entry, exit: criteria.exit }, null, 2);
      $('criteria-advanced-enabled').checked = true;
      $('criteria-explanation').textContent = typeof result.explanation === 'string' ? result.explanation : 'No explanation returned.';
      $('criteria-explanation').hidden = false;
      $('criteria-generation-status').textContent = 'Rules generated. Review Buy / Sell / Hold below, check settings, then choose Review rules & settings. Run remains a separate explicit action. Switch to manual to edit the full proposal.';
    } catch (error) {
      if (revision !== backtest.revision) return;
      if (['archive_mismatch', 'selection_missing', 'invalid_snapshot', 'market_unavailable'].includes(error.code)) copilot.blocked = true;
      $('criteria-generation-status').textContent = `Criteria generation failed · ${error.code || 'unknown'} · Check connection, model and supported criteria. Inputs are unchanged; no automatic retry or backtest.`;
    } finally {
      backtest.generating = false; copilot.busy = false;
      updateCopilotControls();
    }
  }
  for (const id of ['criteria-entry-left', 'criteria-exit-left', 'criteria-operands']) {
    $(id).replaceChildren(...OPERANDS.map(value => { const option = node('option', value); option.value = value; return option; }));
  }
  $('criteria-entry-left').value = 'sma20'; $('criteria-exit-left').value = 'sma20';
  $('backtest-mode').addEventListener('change', () => { updateBacktestMode(); syncBacktest(); });
  $('backtest-symbol').addEventListener('change', () => { state.symbol = $('backtest-symbol').value; renderMarket(); });
  $('criteria-source-natural').addEventListener('click', () => selectRuleSource('natural'));
  $('criteria-source-manual').addEventListener('click', () => selectRuleSource('manual'));
  const modeTabs = [...document.querySelectorAll('[data-backtest-mode]')];
  for (const tab of modeTabs) tab.addEventListener('click', () => {
    if ($('backtest-mode').value === tab.dataset.backtestMode) return;
    $('backtest-mode').value = tab.dataset.backtestMode;
    updateBacktestMode(); syncBacktest(); invalidateBacktest();
  });
  $('backtest-mode-tabs').addEventListener('keydown', event => {
    const index = modeTabs.indexOf(event.target);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? modeTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + modeTabs.length) % modeTabs.length;
    modeTabs[next].click(); modeTabs[next].focus();
  });
  $('portfolio-calendar').addEventListener('change', updateBacktestMode);
  $('backtest-form').addEventListener('input', invalidateBacktest);
  $('backtest-form').addEventListener('change', invalidateBacktest);
  $('backtest-form').addEventListener('submit', previewBacktest);
  $('backtest-run').addEventListener('click', () => void runBacktest());
  $('backtest-download').addEventListener('click', () => research.download(backtest.result, resultIsPortfolio(backtest.result) ? 'portfolio' : 'backtest'));
  $('criteria-question').addEventListener('input', () => {
    backtest.proposal = null; backtest.proposalQuestion = null;
    $('criteria-explanation').hidden = true;
    invalidateBacktest(); updateCopilotControls();
    $('criteria-generation-status').textContent = 'Description changed. Regenerate rules or explicitly switch to Build rules manually. The previous proposal cannot run as this description.';
  });
  $('criteria-generate').addEventListener('click', () => void generateCriteria());
  const renderPages = { signals: renderBacktestSignals, fills: renderBacktestFills, decisions: renderPortfolioDecisions };
  for (const kind of Object.keys(renderPages)) for (const [direction, step] of [['prev', -1], ['next', 1]]) {
    $(`backtest-${kind}-${direction}`).addEventListener('click', () => {
      if (!backtest.result) return;
      backtest.pages[kind] += step; renderPages[kind]();
    });
  }
  $('backtest-signal-symbol').addEventListener('change', () => { backtest.pages.signals = 0; renderBacktestSignals(); });
  $('portfolio-result-book').addEventListener('change', syncPortfolioBook);
  $('portfolio-position-date').addEventListener('change', renderPortfolioPositions);
  $('nav-backtest').addEventListener('click', () => {
    research?.show('backtest');
    $('backtest-title').focus({ preventScroll: true });
    $('backtest-panel').scrollIntoView({ block: 'start' });
  });

  const COPILOT_ERRORS = {
    invalid_request: 'Invalid analysis request. Select a saved observation, available model and a question of 1–4000 characters.',
    not_authenticated: 'Copilot is not authenticated. Sign in through your Copilot host, then explicitly Check connection again.',
    unavailable: 'The Copilot SDK is unavailable. Check the local Copilot setup, then explicitly Check connection again.',
    model_unavailable: 'That model is no longer available. Check connection again and select a returned model.',
    market_unavailable: 'The saved archive could not be read. Verify saved data, then Use current selection.',
    archive_mismatch: 'The latest saved archive changed. No other archive was substituted. Verify saved data, then Use current selection.',
    criteria_unsupported: 'The proposal is unsupported. Entry and exit are unchanged; no backtest started.',
    invalid_criteria: 'Copilot did not return supported structured criteria. Entry and exit are unchanged.',
    selection_missing: 'The selected symbol or timestamp is missing. Verify saved data, then Use current selection.',
    invalid_snapshot: 'The selected archive or indicators are invalid. Verify saved data, then Use current selection.',
    analysis_failed: 'Copilot analysis failed. No answer was substituted and no retry was made.',
    empty_response: 'Copilot returned an empty answer. No answer was substituted and no retry was made.',
    busy: 'A Copilot operation is already pending. Wait for it to finish; no automatic retry.',
    transport_timeout: 'The Copilot request timed out. Completion and usage are unknown; it was not retried.',
    cleanup_failed: 'Copilot resource cleanup could not be confirmed. No successful answer is presented for this request.',
    closed: 'The Copilot service closed. No request was retried.',
  };
  const copilotMessage = error => COPILOT_ERRORS[error?.code] || message(error);
  const sameIdentity = (a, b) => !!a && !!b && a.archiveId === b.archiveId
    && a.symbol === b.symbol && a.timestamp === b.timestamp;
  function selectedIdentity() {
    const bar = selectedBar(), archiveId = state.snapshot?.manifest?.id;
    if (state.snapshot?.manifest?.kind !== 'real_market_snapshot'
      || state.snapshot.manifest.provider !== 'Yahoo Finance'
      || !bar || typeof archiveId !== 'string' || !archiveId) return null;
    return Object.freeze({ symbol: state.symbol, timestamp: bar.timestamp, archiveId, date: bar.date });
  }
  function renderCopilotIdentity(parent, identity) {
    pairs(parent, [['Symbol', identity?.symbol], ['Selected date', identity?.date],
      ['Timestamp · Unix seconds', identity?.timestamp], ['Archive ID', identity?.archiveId]]);
  }
  function renderCopilotUsage(parent, usage) {
    const count = key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : 'Unknown';
    const cost = typeof usage?.estimatedCost === 'number' && Number.isFinite(usage.estimatedCost)
      && usage.estimatedCost >= 0 ? `${usage.estimatedCost} ${raw(usage.currency)}` : 'Unknown';
    pairs(parent, [['Input tokens', count('inputTokens')], ['Output tokens', count('outputTokens')],
      ['Cache read tokens', count('cacheReadTokens')], ['Cache write tokens', count('cacheWriteTokens')],
      ['Usage events (not calls)', count('eventCount')], ['Usage source', usage?.source], ['Estimated cost', cost]]);
  }
  function updateCopilotControls() {
    const identity = selectedIdentity();
    const selectionChanged = !sameIdentity(copilot.observedIdentity, identity)
      && (copilot.observedIdentity !== null || identity !== null);
    // An untouched composer follows selection; drafts never silently change source.
    // Busy operations keep their original immutable pin, even as the workspace changes.
    if (selectionChanged) {
      copilot.observedIdentity = identity;
    }
    if (!copilot.busy && !state.marketBusy && identity && !copilot.blocked
        && (!copilot.identity || (selectionChanged && !$('copilot-question').value.trim() && !$('criteria-question').value.trim()))) {
      pinCopilotSelection(identity);
    }
    const matches = sameIdentity(copilot.identity, identity);
    const model = $('copilot-model').value;
    const question = $('copilot-question').value.trim();
    $('copilot-analyze').disabled = copilot.busy || state.marketBusy || !token || !matches || copilot.blocked
      || !copilot.ready || !copilot.models.some(item => item.id === model)
      || !question || question.length > 4000;
    $('copilot-check').disabled = copilot.busy;
    $('copilot-model').disabled = copilot.busy || !copilot.ready;
    $('copilot-question').disabled = copilot.busy;
    $('copilot-use-selection').disabled = copilot.busy || state.marketBusy || !identity || (matches && !copilot.blocked);
    $('copilot-use-selection').hidden = !identity || (matches && !copilot.blocked);
    $('copilot-form').setAttribute('aria-busy', String(copilot.busy));
    $('copilot-panel').dataset.busy = String(copilot.busy);
    $('copilot-panel').dataset.selectionMatches = String(matches);
    $('copilot-connection-label').textContent = copilot.checking ? 'Checking…' : copilot.ready ? 'Ready' : copilot.connectionLabel || 'Not checked';
    document.querySelectorAll('[data-copilot-suggestion]').forEach(button => { button.disabled = copilot.busy; });
    $('copilot-select-prompt').disabled = !copilot.identity;
    $('copilot-selection-status').textContent = !copilot.identity ? ''
      : !matches ? identity
        ? `Workspace: ${identity.symbol} · ${identity.date}${identity.archiveId !== copilot.identity.archiveId ? ' · different archive' : ''}. ${copilot.busy ? 'Request source stays pinned.' : 'Draft source unchanged.'}`
        : 'Selection unavailable. Verify saved data before sending.'
      : copilot.blocked ? 'Source validation failed. Verify saved data, then use current selection.' : '';
    $('copilot-selection-status').hidden = !$('copilot-selection-status').textContent;
    $('copilot-result-selection').textContent = copilot.resultIdentity && !sameIdentity(copilot.resultIdentity, identity)
      ? 'This answer uses a different source than the current selection.' : '';
    $('copilot-result-selection').hidden = !$('copilot-result-selection').textContent;
    updateBacktestControls();
  }
  function clearCopilotModels(label = 'Check connection to load models') {
    copilot.ready = false;
    copilot.models = [];
    const option = node('option', label); option.value = '';
    $('copilot-model').replaceChildren(option);
  }
  function handoffPrompt(identity) {
    if (!identity) return '';
    return `Read .github/skills/itt-research/SKILL.md and its linked documentation. Work from this repository root in Agent mode, using the already prepared environment. Stop if setup is missing or uncertain; do not install anything.
Read-only permission: no file edits, network fetch, research writes, notes, orders, or additional provider calls.
GUI selection: symbol ${identity.symbol}, date ${identity.date}, provider Unix timestamp ${identity.timestamp} (seconds), archive ID ${identity.archiveId}.
Run ./run.ps1 cli market show against the default store. Check exit code and JSON ok; stop on errors or invalid output.
Require result.manifest.kind real_market_snapshot and provider Yahoo Finance. Use only real saved market observations and their derived indicators; stop if unavailable. User-criteria price-return simulation is a separate explicit action, not PIT evidence; do not run it for this read-only lookup.
BEFORE inspecting or comparing quotes, require result.manifest.id to equal ${identity.archiveId}. If latest changed, STOP and report the mismatch; do not fetch, scan older folders, use a different archive, or invent a market-show-by-archive-ID option. Ask the user to Verify the GUI and copy a new selection.
Only after the archive matches, find exactly one result.symbols entry with symbol ${identity.symbol}, then exactly one bars entry with integer timestamp ${identity.timestamp}. Require date ${identity.date}; stop if missing or mismatched. Report exact OHLCV strings, date_basis, price_basis, provider, collected_at, and archive ID from that same response. Do not substitute summary.last_price, another date, or historical documentation values. Repeat the archive-ID guard on every later market show.
For trend analysis, use only that symbol's bars and aligned indicators from the archive start through the selected timestamp inclusive. Do not use later bars, latest summary prices or other symbols as analysis context.
This is archived evidence, not a live quote, historical point-in-time proof, total return or investment performance. Hashes verify saved bytes, not authenticity. No web/news search. Answer in the user's language.`;
  }
  function pinCopilotSelection(identity) {
    if (!identity || copilot.busy) return;
    copilot.identity = identity;
    copilot.blocked = false;
    renderCopilotIdentity($('copilot-identity'), identity);
    $('copilot-pinned-label').textContent = `${identity.symbol} · ${identity.date}`;
    $('copilot-pinned-label').title = `Archive ${identity.archiveId} · timestamp ${identity.timestamp}`;
    $('copilot-panel').dataset.symbol = identity.symbol;
    $('copilot-panel').dataset.timestamp = String(identity.timestamp);
    $('copilot-panel').dataset.archiveId = identity.archiveId;
    $('copilot-sharing').textContent = `Send shares public saved ${identity.symbol} data through ${identity.date}, aligned indicators and your question with GitHub Copilot. Do not include secrets.`;
    $('copilot-handoff-prompt').value = handoffPrompt(identity);
  }
  function focusCopilot() {
    updateCopilotControls();
    // Action buttons focus without overwriting an existing draft's source. Repinning is explicit.
    const target = copilot.busy ? $('copilot-history') : $('copilot-question');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }
  function useCurrentSelection() {
    if (copilot.busy || state.marketBusy || !selectedIdentity()) return;
    pinCopilotSelection(selectedIdentity());
    updateCopilotControls();
    focusCopilot();
  }
  function archivePreviousAnswer() {
    if ($('copilot-result').hidden) return;
    const entry = node('article', undefined, 'copilot-message');
    entry.dataset.testid = 'copilot-history-entry';
    entry.dataset.symbol = copilot.resultIdentity.symbol;
    entry.dataset.timestamp = String(copilot.resultIdentity.timestamp);
    entry.dataset.archiveId = copilot.resultIdentity.archiveId;
    const answer = $('copilot-answer').cloneNode(true);
    answer.removeAttribute('id');
    entry.append(node('h3', 'Copilot'),
      node('p', $('copilot-result-source').textContent, 'copilot-message-source'),
      node('p', $('copilot-result-question').textContent, 'copilot-message-question'),
      answer);
    const details = node('details');
    details.append(node('summary', 'Original answer source & usage'));
    for (const id of ['copilot-result-identity', 'copilot-usage']) {
      const copy = $(id).cloneNode(true); copy.removeAttribute('id'); details.append(copy);
    }
    entry.append(details);
    $('copilot-transcript').append(entry);
  }
  function renderCopilotAnswer(answer) {
    const content = node('div');
    // Fail closed to readable text if a local vendor asset is unavailable.
    if (!globalThis.marked?.parse || !globalThis.DOMPurify?.sanitize) {
      content.append(node('p', answer));
      return content;
    }
    const escapeHTML = text => String(text).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    const renderer = new globalThis.marked.Renderer();
    // Provider HTML is evidence text, never trusted markup (including inline HTML).
    renderer.html = token => escapeHTML(typeof token === 'string' ? token : token.text);
    content.innerHTML = globalThis.DOMPurify.sanitize(globalThis.marked.parse(answer, {
      gfm: true, breaks: true, renderer,
    }), {
      ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'em', 'del',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
      ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    });
    // Only trusted, locally created wrappers get attributes; provider attributes are stripped.
    for (const table of content.querySelectorAll('table')) {
      const wrapper = node('div', undefined, 'copilot-table-scroll');
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', 'Answer table');
      table.replaceWith(wrapper); wrapper.append(table);
    }
    for (const pre of content.querySelectorAll('pre')) pre.tabIndex = 0;
    return content;
  }
  async function checkCopilot() {
    if (copilot.busy) return;
    copilot.busy = true;
    copilot.checking = true;
    copilot.connectionLabel = null;
    clearCopilotModels('Checking model metadata…');
    pairs($('copilot-account-values'), [['Account metadata', 'Checking…']]);
    renderCopilotUsage($('copilot-connection-usage'), null);
    setError('settings-error');
    $('copilot-connection').textContent = 'Checking SDK authentication… No inference requested.';
    updateCopilotControls();
    try {
      const result = await api('copilot.status', {});
      if (!result || !['ready', 'connected', 'not_authenticated', 'unavailable'].includes(result.status)
          || typeof result.authenticated !== 'boolean' || !Array.isArray(result.models)) throw fault('invalid_response');
      renderCopilotUsage($('copilot-connection-usage'), result.usage);
      const account = result.identity || {};
      const safeMetadata = value => typeof value === 'string' && value.length <= 200
        && !/[\x00-\x1f\x7f]/.test(value) ? value : 'Not reported';
      pairs($('copilot-account-values'), [['Authenticated', result.authenticated],
        ['Login', safeMetadata(account.login)], ['Host', safeMetadata(account.host)],
        ['Auth type', safeMetadata(account.authType)]]);
      if (result.error) throw fault(result.error.code);
      if (result.status !== 'ready') throw fault(result.status);
      if (!result.authenticated) throw fault('not_authenticated');
      if (!result.models.length || !result.models.every(item => typeof item?.id === 'string' && item.id.trim()
          && typeof item.name === 'string' && item.name.trim())) throw fault('invalid_response');
      clearCopilotModels('Select a returned model');
      copilot.models = result.models.map(({ id, name }) => ({ id, name }));
      for (const model of copilot.models) {
        const option = node('option', `${model.name} · ${model.id}`); option.value = model.id;
        $('copilot-model').append(option);
      }
      // Auto is selectable only when actually returned by the SDK; never invent a model.
      const auto = copilot.models.find(model => model.id.toLowerCase() === 'auto');
      if (auto) $('copilot-model').value = auto.id;
      copilot.ready = true;
      $('copilot-connection').textContent = 'Ready · authenticated + model metadata only; inference not verified by this check.';
    } catch (error) {
      clearCopilotModels();
      copilot.connectionLabel = 'Connection check failed';
      $('copilot-connection').textContent = error.code === 'not_authenticated' ? 'Not authenticated · models cleared' : 'Unavailable · models cleared';
      setError('settings-error', copilotMessage(error));
    } finally {
      copilot.checking = false;
      copilot.busy = false;
      if (!copilot.identity) pinCopilotSelection(selectedIdentity());
      updateCopilotControls();
    }
  }
  async function analyzeCopilot(event) {
    event.preventDefault();
    updateCopilotControls();
    if ($('copilot-analyze').disabled) return;
    // Snapshot only primitives. Neither a later chart selection nor form edits can mutate this request.
    const identity = copilot.identity;
    const request = Object.freeze({ symbol: identity.symbol, timestamp: identity.timestamp, archiveId: identity.archiveId,
      model: $('copilot-model').value, question: $('copilot-question').value.trim() });
    copilot.busy = true;
    setError('copilot-error');
    $('copilot-progress').textContent = 'Thinking…';
    updateCopilotControls();
    try {
      const result = await api('copilot.analyze', request);
      if (!sameIdentity(result?.contextIdentity, identity) || result?.scope !== 'saved_snapshot_only'
          || (result.model !== undefined && result.model !== request.model)) throw fault('invalid_response');
      if (typeof result.answer !== 'string' || !result.answer.trim()) throw fault('empty_response');
      const answer = renderCopilotAnswer(result.answer);
      archivePreviousAnswer();
      copilot.resultIdentity = identity;
      $('copilot-result-source').textContent = `${identity.symbol} · through ${identity.date} · ${request.model}`;
      $('copilot-result-question').textContent = request.question;
      $('copilot-result').dataset.symbol = identity.symbol;
      $('copilot-result').dataset.timestamp = String(identity.timestamp);
      $('copilot-result').dataset.archiveId = identity.archiveId;
      renderCopilotIdentity($('copilot-result-identity'), identity);
      const provenance = node('div'), details = node('dd');
      details.textContent = raw({ model: request.model, question: request.question, scope: result.scope, contextIdentity: result.contextIdentity });
      provenance.append(node('dt', 'Submitted question / model / backend context'), details);
      $('copilot-result-identity').append(provenance);
      $('copilot-answer').replaceChildren(...answer.childNodes);
      $('copilot-result').querySelector('details').open = false;
      renderCopilotUsage($('copilot-usage'), result.usage);
      $('copilot-result').hidden = false;
      $('copilot-empty').hidden = true;
      $('copilot-history').scrollTop = $('copilot-result').offsetTop - $('copilot-history').offsetTop;
      $('copilot-question').value = '';
    } catch (error) {
      if (['archive_mismatch', 'selection_missing', 'invalid_snapshot', 'market_unavailable'].includes(error.code)) copilot.blocked = true;
      if (['not_authenticated', 'model_unavailable', 'unavailable', 'unauthorized', 'auth_required', 'closed'].includes(error.code)) {
        clearCopilotModels();
        $('copilot-connection').textContent = 'Connection needs rechecking · models cleared';
      }
      setError('copilot-error', copilotMessage(error));
    } finally {
      $('copilot-progress').textContent = '';
      copilot.busy = false;
      const currentIdentity = selectedIdentity();
      if (currentIdentity && !copilot.blocked && !$('copilot-question').value.trim()
          && !$('criteria-question').value.trim() && !sameIdentity(identity, currentIdentity)) pinCopilotSelection(currentIdentity);
      updateCopilotControls();
    }
  }
  for (const id of ['ask-copilot', 'evidence-copilot', 'why-copilot']) $(id).addEventListener('click', focusCopilot);
  $('copilot-use-selection').addEventListener('click', useCurrentSelection);
  document.querySelectorAll('[data-copilot-suggestion]').forEach(button => button.addEventListener('click', () => {
    if (copilot.busy) return;
    // Suggestions fill an empty question only; existing drafts are never discarded.
    if (!$('copilot-question').value.trim()) $('copilot-question').value = button.dataset.copilotSuggestion;
    focusCopilot();
  }));
  $('copilot-check').addEventListener('click', () => void checkCopilot());
  $('copilot-form').addEventListener('submit', event => void analyzeCopilot(event));
  $('copilot-question').addEventListener('input', updateCopilotControls);
  $('copilot-question').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!$('copilot-analyze').disabled) $('copilot-form').requestSubmit();
    }
  });
  $('copilot-model').addEventListener('change', () => { invalidateBacktest(); updateCopilotControls(); });
  $('copilot-select-prompt').addEventListener('click', () => {
    $('copilot-handoff-prompt').focus(); $('copilot-handoff-prompt').select();
  });
  $('why-evidence').addEventListener('click', () => {
    research?.show('markets');
    $('selected-evidence').open = true; $('evidence-title').focus();
  });

  function sourceSection(title) {
    const section = node('section', undefined, 'source-section');
    section.append(node('h3', title)); $('source-content').append(section); return section;
  }
  function renderSources() {
    $('source-content').replaceChildren();
    const boundaries = sourceSection('Real saved market data');
    boundaries.append(node('p', 'Yahoo daily OHLCV records are the open, high, low, close and traded volume for each stored session. SMA20/SMA50 and RSI14 are derived from those saved closes, not trading results.'),
      node('p', 'User-criteria price-return simulation is available on saved data, not historical PIT or dividend total return. Orders unavailable. Explicit Copilot execution sends only the pinned symbol’s saved bars and aligned indicators through the selected date. No live feed or web/news search.', 'muted'));
    if (!state.snapshot) {
      $('source-content').append(node('p', 'No readable market archive. Fetch Yahoo data saves raw responses; Verify saved data rereads and verifies saved bytes.', 'source-section'));
      return;
    }
    const manifest = state.snapshot.manifest, item = current();
    let section = sourceSection('Archive identity'), list = node('dl', undefined, 'detail-list');
    pairs(list, [['Archive ID', manifest.id], ['Provider', manifest.provider], ['Collected UTC', manifest.collected_at],
      ['Verification', state.verification], ['Requested window / interval', manifest.requested_bounds
        ? `${manifest.requested_bounds.start} — ${manifest.requested_bounds.end} (inclusive) / 1d` : 'Legacy 1y / 1d; explicit dates not recorded'], ['Selected instrument', state.symbol],
      ['First observation', item?.bars[0]?.date], ['Last observation', item?.bars.at(-1)?.date]]); section.append(list);
    section = sourceSection('Raw response SHA256 · full hashes');
    for (const [name, hash] of Object.entries(manifest.raw_sha256 || {})) {
      const block = node('div', undefined, 'source-hash'); block.append(node('strong', name), node('code', raw(hash))); section.append(block);
    }
    section.append(node('p', 'Verify rereads the latest pointer, checks the manifest and every raw hash, and normalizes the raw responses again. The API does not expose the manifest hash itself.', 'muted'));
    section = sourceSection('Provider requests');
    for (const [name, url] of Object.entries(manifest.request_urls || {})) {
      const block = node('div', undefined, 'source-hash'); block.append(node('strong', name), node('code', raw(url))); section.append(block);
    }
    section = sourceSection('Interpretation & limitations'); list = node('dl', undefined, 'detail-list');
    pairs(list, [['Price basis', manifest.price_basis], ['Current archive is not PIT', manifest.current_archive_not_pit],
      ['Historical universe verified', manifest.historical_universe_verified], ['External audit', manifest.external_audit],
      ['Latest bar may be incomplete', manifest.latestbar_may_be_incomplete], ['Use / redistribution rights', manifest.rights],
      ['Backtesting', 'User criteria → signals → next-open price-return simulation; not PIT'], ['Orders', 'Unavailable'], ['Currency / exchange', `${raw(item?.currency)} / ${raw(item?.exchange)}`],
      ['Exchange timezone', item?.timezone], ['Date basis', item?.date_basis], ['Missing bars and calendar gaps', item?.missing_bars],
      ['Corporate events', item?.events]]); section.append(list);
    section.append(node('p', 'PIT means information available at the historical decision time. Current Yahoo archives do not establish that availability or a survivorship-free historical universe. Close may be provider-adjusted; price change is not total return. Corporate events are provider records, not simulated cashflows.', 'source-section muted'));
    const details = node('details'); details.append(node('summary', 'Complete stored manifest'), node('pre', raw(manifest))); $('source-content').append(details);
  }

  function setTab(tab) {
    state.tab = tab;
    for (const name of ['chart', 'prices']) {
      $(`tab-${name}`).setAttribute('aria-selected', String(tab === name));
      $(`tab-${name}`).tabIndex = tab === name ? 0 : -1;
      $(`${name}-view`).hidden = tab !== name;
    }
    if (tab === 'chart') renderChart();
    else selectBar(visibleBars().indexOf(selectedBar()), false);
  }
  for (const name of ['chart', 'prices']) $(`tab-${name}`).addEventListener('click', () => setTab(name));
  document.querySelector('[aria-label="Market display"]').addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'chart' : event.key === 'End' ? 'prices' : state.tab === 'chart' ? 'prices' : 'chart';
    setTab(tab); $(`tab-${tab}`).focus();
  });
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    state.period = button.dataset.period;
    document.querySelectorAll('[data-period]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    renderChart(); renderPrices(); renderObservations(); renderSelection();
  }));
  document.querySelectorAll('[data-chart-mode]').forEach(button => button.addEventListener('click', () => {
    state.chartMode = button.dataset.chartMode;
    document.querySelectorAll('[data-chart-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    renderChart();
  }));
  for (const key of ['volume', ...Object.keys(INDICATORS)]) $(`toggle-${key}`).addEventListener('change', event => {
    state[key] = event.target.checked;
    renderChart();
  });
  $('watch-search').addEventListener('input', renderWatchlist);
  $('watchlist').addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]')) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...$('watchlist').querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); buttons[next].click();
  });
  $('fetch-market').addEventListener('click', () => void loadMarket(true));
  $('empty-fetch').addEventListener('click', () => void loadMarket(true));
  $('verify-market').addEventListener('click', () => void loadMarket());
  $('signal-button').addEventListener('click', () => {
    const expanded = $('signal-button').getAttribute('aria-expanded') !== 'true';
    $('signal-button').setAttribute('aria-expanded', String(expanded));
    $('signal-details').hidden = !expanded;
  });
  for (const id of ['nav-markets', 'rail-markets']) $(id).addEventListener('click', () => {
    research?.show('markets');
    $('market-title').focus();
    $('markets-view').scrollIntoView({ block: 'nearest' });
  });
  for (const id of ['source-top', 'scope-sources', 'details-sources']) $(id).addEventListener('click', () => {
    renderSources(); $('source-dialog').showModal();
  });
  $('close-sources').addEventListener('click', () => $('source-dialog').close());
  let settingsOpener = null;
  $('nav-settings').addEventListener('click', event => {
    if ($('settings-dialog').open) return;
    settingsOpener = event.currentTarget;
    $('settings-dialog').showModal();
  });
  $('close-settings').addEventListener('click', () => $('settings-dialog').close());
  $('settings-dialog').addEventListener('cancel', event => {
    event.preventDefault();
    $('settings-dialog').close();
  });
  $('settings-dialog').addEventListener('close', () => {
    const target = settingsOpener?.isConnected && settingsOpener.getClientRects().length
      ? settingsOpener : $('nav-settings');
    target.focus({ preventScroll: true });
    settingsOpener = null;
  });
  $('source-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      $('source-dialog').close();
    }
  });
  $('source-dialog').addEventListener('click', event => {
    if (event.target !== $('source-dialog')) return;
    const box = $('source-dialog').getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('source-dialog').close();
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || document.querySelector('dialog[open]')
        || event.target.closest('#copilot-panel, input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === '/') { event.preventDefault(); research?.show('markets'); $('watch-search').focus(); }
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); void loadMarket(); }
  });
  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { if (state.tab === 'chart') renderChart(); });
  }).observe(document.querySelector('.chart-column'));

  research = window.ITTResearch({ api, state, loadMarket, invalidateBacktest, activeRules, rulesReviewed: () => !!backtest.reviewed,
    validSymbol, validCriterion, message, node, numeric, price });
  // Research supplies translated option labels; the shared schema owns the final list.
  for (const id of ['criteria-entry-op', 'criteria-exit-op']) {
    const labels = new Map([...$(id).options].map(option => [option.value, option.textContent]));
    const selected = $(id).value;
    $(id).replaceChildren(...OPERATORS.map(value => { const option = node('option', labels.get(value) || value); option.value = value; return option; }));
    $(id).value = selected;
  }
  // Existing controls keep their names, IDs and behavior; glyphs are decorative only.
  for (const button of document.querySelectorAll('[data-ui-icon]')) button.prepend(visualIcon(button.dataset.uiIcon));
  renderMarket();
  // No market.fetch or Copilot status/inference on startup, tab changes or errors.
  void loadMarket();
})();