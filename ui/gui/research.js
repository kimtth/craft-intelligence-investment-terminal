/* Research presentation only. All non-demo calculations belong to the backend. */
(() => {
  'use strict';
  window.ITTResearch = ({ api, state, loadMarket, invalidateBacktest, activeRules, rulesReviewed,
    validSymbol, validCriterion, message, node, numeric, price }) => {
    const $ = id => document.getElementById(id);
    const pct = value => numeric(value) ? `${price(Number(value) * 100)}%` : 'Unavailable';
    const json = value => JSON.stringify(value, null, 2);
    const errorText = error => error instanceof SyntaxError ? 'Invalid JSON syntax.' : error instanceof TypeError ? 'Invalid input or response structure.' : error.code ? `Request failed · ${error.code} · ${message(error)}` : error.message;
    const setError = (id, text = '') => { $(id).textContent = text; $(id).hidden = !text; };
    const symbols = () => state.snapshot?.symbols.map(item => item.symbol) || [];
    const parseSymbols = text => {
      const selected = text.trim().toUpperCase().split(/[\s,]+/).filter(Boolean);
      if (!selected.length || selected.length > 10 || selected.some(item => !validSymbol(item))
        || new Set(selected).size !== selected.length) throw new Error('Enter 1–10 unique Yahoo symbols. No substitute assets are used.');
      return selected;
    };
    const calendarDate = value => typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
      && value.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    const today = new Date();
    const year = today.getFullYear(), month = today.getMonth(), day = today.getDate();
    const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    // Clamp Feb 29 to Feb 28, not March 1; use the user's local calendar today.
    $('assets-start').value = iso(year - 5, month, Math.min(day, new Date(year - 5, month + 1, 0).getDate()));
    $('assets-end').value = iso(year, month, day);
    let downloadDraftEdited = false;
    function downloadDates() {
      const start = $('assets-start').value, end = $('assets-end').value;
      if (!calendarDate(start) || !calendarDate(end) || end === '9999-12-31') throw new Error('Enter valid Start date and End date in YYYY-MM-DD format.');
      if (start > end) throw new Error('End date must be on or after Start date. Both dates are inclusive.');
      return { start, end };
    }
    const tabs = [...document.querySelectorAll('[data-research-view]')];
    let view = 'markets', archive = null, weightUniverse = '', correlationBusy = false;
    let correlationRevision = 0;
    let correlationResult = null, triggerResult = null, triggerBusy = false, triggerRevision = 0, triggerIdentity = '';
    let triggerWindowIdentity = '', loadedArchive = null, cachedWeightUniverse = '';
    const viewNames = { markets: 'Markets', assets: 'Assets', backtest: 'Backtest', correlation: 'Correlation', trigger: 'Event studies', guru: 'Guru', swarm: 'Quant Swarm' };
    const swarm = typeof window.ITTSwarm === 'function' ? window.ITTSwarm($('swarm-stage')) : null;
    swarm?.setVisible(false);
    let guru = null;
    // These controls always open the saved-market drawer, never the Guru feed.
    const sourceControls = ['source-top'].map(id => ({
      element: $(id), title: $(id).title, label: $(id).getAttribute('aria-label'),
    }));
    const sourceTitle = $('source-title').textContent;
    function download(result, name) {
      if (!result) return;
      const url = URL.createObjectURL(new Blob([json(result)], { type: 'application/json' }));
      const link = node('a'); link.href = url; link.download = `itt-${name}.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    $('correlation-download').addEventListener('click', () => download(correlationResult, 'correlation'));
    $('trigger-download').addEventListener('click', () => download(triggerResult, 'trigger'));
    const weightCache = new Map();
    function show(next) {
      if (!Object.hasOwn(viewNames, next)) return;
      const previous = view;
      view = next;
      const isResearch = ['correlation', 'trigger', 'guru'].includes(view);
      for (const tab of tabs) {
        const active = tab.dataset.researchView === view;
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      }
      $('markets-view').hidden = view !== 'markets';
      $('assets-workspace').hidden = view !== 'assets';
      $('backtest-workspace').hidden = view !== 'backtest';
      $('research-workspace').hidden = !isResearch;
      $('research-tabs').hidden = !isResearch;
      $('swarm-view').hidden = view !== 'swarm';
      document.querySelector('.app-shell').classList.toggle('swarm-demo', view === 'swarm');
      document.querySelector('.app-shell').classList.toggle('chat-hidden', view !== 'markets');
      $('research-workspace').classList.toggle('guru-workspace', view === 'guru');
      // Hide the existing node, never remount chat or reset its draft/settings/history.
      // Chat receives selected market context only; it cannot explain these other views.
      $('copilot-panel').hidden = view !== 'markets';
      $('market-actions').hidden = view !== 'markets';
      document.querySelector('.topbar .search-field').hidden = view !== 'markets';
      document.querySelector('.research-data').hidden = view !== 'assets';
      document.querySelector('.workspace-why').hidden = view !== 'markets';
      for (const name of ['correlation', 'trigger', 'guru']) $(`research-${name}`).hidden = name !== view;
      swarm?.setVisible(view === 'swarm');
      if (previous === 'guru' && view !== 'guru') guru?.hide();
      if (view === 'guru' && previous !== 'guru') {
        if (!guru && typeof window.ITTGuru === 'function') guru = window.ITTGuru({ root: $('guru-browser'), api, node, message, numeric, price });
        guru?.show();
      }
      for (const [id, active] of [['nav-markets', view === 'markets'], ['rail-markets', view === 'markets'], ['rail-sources', view === 'assets'], ['nav-backtest', view === 'backtest'], ['nav-research', isResearch], ['nav-swarm', view === 'swarm']]) {
        $(id).classList.toggle('active', active);
        if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
      }
      locationLabel();
      syncArchive();
    }
    function locationLabel() {
      $('workspace-location').textContent = view === 'markets' ? `Markets / ${state.symbol}`
        : ['assets', 'backtest', 'swarm'].includes(view) ? viewNames[view] : `Research / ${viewNames[view]}`;
      const scope = view === 'guru'
        ? ['easyinvesting.app', 'Quarterly 13F', 'USD', 'Automatic reference feed']
        : view === 'swarm'
          ? ['Simulated', 'Illustrative metrics', 'No real trades', 'Authored concept · no model calls']
          : ['Yahoo Finance', 'Daily bars · saved coverage', state.snapshot?.symbols.find(item => item.symbol === state.symbol)?.currency || 'USD', 'Local snapshot · read-only'];
      for (const [index, id] of ['scope-provider', 'scope-frequency', 'scope-currency', 'scope-mode'].entries()) $(id).textContent = scope[index];
      const separateSource = ['guru', 'swarm'].includes(view);
      for (const { element, title, label } of sourceControls) {
        element.title = separateSource ? 'Saved Yahoo provenance · not this workspace’s source' : title;
        element.setAttribute('aria-label', separateSource ? 'Open saved Yahoo provenance' : label);
      }
      $('source-title').textContent = separateSource ? 'Saved Yahoo provenance' : sourceTitle;
    }
    for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.researchView));
    $('research-tabs').addEventListener('keydown', event => {
      const index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
    $('nav-research').addEventListener('click', () => { show('correlation'); $('research-tab-correlation').focus(); });
    $('nav-swarm').addEventListener('click', () => show('swarm'));
    $('rail-sources').addEventListener('click', () => {
      show('assets');
      $('research-symbols').focus({ preventScroll: true });
    });
    // Capture prevents the legacy Markets fetch listeners from downloading before asset review.
    // The main controller may also route these data-open-assets buttons to show('assets').
    for (const control of document.querySelectorAll('[data-open-assets]')) control.addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation(); show('assets'); $('research-symbols').focus();
    }, { capture: true });
    document.addEventListener('dataopenassets', () => show('assets'));
    $('assets-verify').addEventListener('click', () => { setError('assets-error'); void loadMarket(); });
    $('trigger-open-backtest').addEventListener('click', () => $('nav-backtest').click());

    const usesBacktest = () => $('trigger-condition-source').value === 'backtest';
    // Reuse the main controller's schema-populated operand options, not a second allowlist.
    $('trigger-left').replaceChildren(...[...$('criteria-entry-left').options].map(option => option.cloneNode(true)));
    $('trigger-left').value = 'rsi14';
    function sourceStatus() {
      $('research-fetch').disabled = state.marketBusy;
      $('research-fetch').textContent = state.marketBusy ? 'Loading market data…' : 'Download market data';
      $('assets-verify').disabled = state.marketBusy;
      $('research-fetch-form').setAttribute('aria-busy', String(state.marketBusy));
      for (const id of ['research-symbols', 'assets-start', 'assets-end']) $(id).disabled = state.marketBusy;
      const id = state.snapshot?.manifest?.id;
      const bounds = state.snapshot?.manifest?.requested_bounds;
      $('assets-requested').textContent = !id ? 'No saved request window loaded.' : bounds
        ? `Saved requested window: ${bounds.start} — ${bounds.end} (both inclusive). Actual coverage per asset is shown below.`
        : 'Saved request: legacy 1y / 1d; explicit date bounds were not recorded. Actual coverage per asset is shown below.';
      $('research-source').textContent = state.marketBusy
        ? `${state.verification} No substitute values; waiting for the data request.`
        : id ? `Saved Yahoo archive ${id} · ${state.verification}` : 'No readable saved archive. Enter assets and download, or verify existing saved data.';
      table($('assets-table'), ['Asset', 'Currency', 'First session', 'Last session', 'Sessions', 'Verification'],
        (state.snapshot?.symbols || []).map(item => [item.symbol, item.currency, item.bars[0]?.date,
          item.bars.at(-1)?.date, item.bars.length, state.verification]), 'Saved assets and coverage');
      // loadMarket handles errors internally; surface its safe message in this workspace too.
      if (!state.marketBusy && !id && !$('market-error').hidden) setError('assets-error', $('market-error').textContent);
    }

    function syncTriggerInputs() {
      const id = state.snapshot?.manifest?.id, saved = symbols(), reviewed = usesBacktest();
      for (const name of ['trigger-symbol', 'trigger-target-symbol']) {
        const select = $(name), selected = select.value;
        if (id && [...select.options].map(option => option.value).join(',') !== saved.join(',')) {
          select.replaceChildren(...saved.map(symbol => { const option = node('option', symbol); option.value = symbol; return option; }));
          select.value = saved.includes(selected) ? selected : saved.includes(state.symbol) ? state.symbol : saved[0] || '';
        }
      }
      if (reviewed && id) $('trigger-symbol').value = state.symbol;
      const windowIdentity = `${id}:${$('trigger-symbol').value}:${reviewed}`;
      if (id && windowIdentity !== triggerWindowIdentity) {
        triggerWindowIdentity = windowIdentity;
        const bars = state.snapshot.symbols.find(item => item.symbol === $('trigger-symbol').value)?.bars || [];
        for (const name of ['trigger-start', 'trigger-end']) $(name).replaceChildren(...bars.map(bar => {
          const option = node('option', bar.date); option.value = bar.date; return option;
        }));
        $('trigger-start').value = bars[Math.max(0, bars.length - 126)]?.date || '';
        $('trigger-end').value = bars.at(-1)?.date || '';
      }
      if (reviewed) {
        $('trigger-start').value = $('backtest-start').value;
        $('trigger-end').value = $('backtest-end').value;
      }
      $('trigger-manual-fields').hidden = reviewed;
      $('trigger-manual-fields').disabled = reviewed;
      for (const name of ['trigger-symbol', 'trigger-start', 'trigger-end']) $(name).disabled = reviewed;
      $('trigger-input-summary').textContent = reviewed
        ? rulesReviewed() ? `Reviewed Backtest inputs: ${state.symbol} · ${$('backtest-start').value} — ${$('backtest-end').value}. Active entry criterion only; exit and costs are excluded.`
          : 'No reviewed Backtest inputs. Review rules and settings in Backtest, or choose Independent condition.'
        : 'Independent condition and dates. Backtest rules, exits and costs are not used. Changing the condition asset initializes its saved-session window; changing the target does not shift dates.';
      // Track producer transitions wherever inputs synchronize, including source edits
      // before an immediate submit. Completion/navigation must not rediscover that edit.
      // Keep revision invalidation: changing away and back still discards pending work.
      const identity = `${id || null}:${reviewed ? 'backtest' : 'manual'}:${reviewed ? state.symbol : ''}:${state.marketBusy}`;
      if (identity !== triggerIdentity) {
        triggerIdentity = identity; invalidateTrigger(true);
      }
      updateTriggerControls();
    }

    function triggerSpec() {
      if (state.marketBusy) throw new Error('Market data is loading. Wait for the current download or verification.');
      const id = state.snapshot?.manifest?.id;
      if (!id) throw new Error('No saved archive. Open Assets and download market data or verify saved data first.');
      if (usesBacktest() && !rulesReviewed()) throw new Error('Review rules and settings in Backtest, or choose Independent condition.');
      const condition = usesBacktest() ? activeRules().entry : { left: $('trigger-left').value, op: $('trigger-op').value, right: $('trigger-right').value.trim() };
      if (!validCriterion(condition)) throw new Error('Invalid condition. Choose a supported operand and comparison; enter a decimal number or a listed operand on the right.');
      const text = $('trigger-horizons').value.trim();
      if (!/^\d+(\s*,\s*\d+)*$/.test(text)) throw new Error('Enter forward session counts as comma-separated integers, such as 1,5,20.');
      const horizons = text.split(',').map(Number);
      if (horizons.length > 60 || horizons.some(h => !Number.isInteger(h) || h < 1 || h > 60) || new Set(horizons).size !== horizons.length) throw new Error('Forward session counts must be unique integers from 1 to 60.');
      const spec = { archive_id: id, symbol: usesBacktest() ? state.symbol : $('trigger-symbol').value,
        target_symbol: $('trigger-target-symbol').value, start: usesBacktest() ? $('backtest-start').value : $('trigger-start').value,
        end: usesBacktest() ? $('backtest-end').value : $('trigger-end').value, condition, horizons };
      if (!symbols().includes(spec.symbol) || !symbols().includes(spec.target_symbol)) throw new Error('The condition and target assets must both be in the current saved data.');
      if (!spec.start || !spec.end || spec.start >= spec.end) throw new Error('Choose an end session after the start session. At least two saved sessions are needed.');
      for (const symbol of new Set([spec.symbol, spec.target_symbol])) {
        const dates = state.snapshot.symbols.find(item => item.symbol === symbol).bars.map(bar => bar.date);
        if (!dates.includes(spec.start) || !dates.includes(spec.end)) throw new Error('Start and end must be actual saved sessions for both assets. Dates are not adjusted automatically.');
      }
      return spec;
    }
    function updateTriggerControls() {
      let reason = '';
      try { triggerSpec(); } catch (error) { reason = errorText(error); }
      if (triggerBusy) reason = 'An event study is running. Changed inputs discard its result; wait before running again.';
      $('trigger-run').disabled = !!reason;
      $('trigger-disabled-reason').textContent = reason || 'Ready to analyze the selected condition and saved-session window.';
      $('trigger-form').setAttribute('aria-busy', String(triggerBusy));
    }

    function syncArchive() {
      const id = state.snapshot?.manifest?.id || null, saved = symbols();
      sourceStatus();
      $('correlation-run').disabled = !id || state.marketBusy || correlationBusy;
      locationLabel();
      syncTriggerInputs();
      if (id !== archive) {
        archive = id; correlationRevision++;
        $('correlation-result').hidden = true; correlationResult = null;
        $('correlation-status').textContent = id ? 'Saved data ready. Set assets, dates and frequency, then calculate.' : 'Load saved data before calculating.';
        if (id) {
          const bars = state.snapshot.symbols[0].bars;
          $('correlation-symbols').value = saved.join(', ');
          $('correlation-start').value = bars[0].date;
          $('correlation-end').value = bars.at(-1).date;
        }
      }
      if (id && id !== loadedArchive) {
        loadedArchive = id;
        // Upgrade the former default download selection, not the saved data itself.
        // Custom universes remain unchanged; collecting MSFT still requires Download.
        const legacyDefaults = saved.length === 3 && ['SPY', 'QQQ', 'IWM'].every(symbol => saved.includes(symbol));
        if (!downloadDraftEdited) {
          $('research-symbols').value = (legacyDefaults ? [...saved, 'MSFT'] : saved).join(', ');
          const bounds = state.snapshot.manifest.requested_bounds;
          if (bounds) { $('assets-start').value = bounds.start; $('assets-end').value = bounds.end; }
        }
        setError('assets-error');
      }
      const universe = saved.join(',');
      if (universe !== weightUniverse) {
        for (const input of $('portfolio-weights').querySelectorAll('input')) weightCache.set(input.dataset.symbol, input.value);
        // Verification temporarily clears the snapshot. Restore edited weights only for
        // that same universe; adding/removing assets starts a new equal-weight draft.
        if (saved.length && universe !== cachedWeightUniverse) {
          weightCache.clear(); cachedWeightUniverse = universe;
        }
        weightUniverse = universe;
        $('portfolio-weights').replaceChildren();
        for (const symbol of saved) {
          const label = node('label', `${symbol} weight · 0–1`), input = node('input');
          input.id = `portfolio-weight-${symbol}`; input.dataset.symbol = symbol;
          input.inputMode = 'decimal'; input.required = true;
          input.value = weightCache.get(symbol) ?? String(Math.floor(1e8 / saved.length) / 1e8);
          label.append(input); $('portfolio-weights').append(label);
        }
      }
    }
    $('research-fetch-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (state.marketBusy) return;
      setError('assets-error');
      try { await loadMarket(true, parseSymbols($('research-symbols').value), downloadDates()); }
      catch (error) { setError('assets-error', errorText(error)); }
    });
    for (const id of ['research-symbols', 'assets-start', 'assets-end']) $(id).addEventListener('input', () => {
      downloadDraftEdited = true; setError('assets-error');
    });
    $('portfolio-apply-preset').addEventListener('click', () => {
      const saved = symbols(), classic = $('portfolio-preset').value === 'classic';
      if (!saved.length || classic && !['SPY', 'QQQ', 'IWM'].every(symbol => saved.includes(symbol))) {
        setError('backtest-error', 'Required example assets are not saved. Open Assets to download them explicitly. No automatic fetch or substitute assets.'); return;
      }
      for (const symbol of saved) $(`portfolio-weight-${symbol}`).value = classic
        ? ({ SPY: '0.5', QQQ: '0.3', IWM: '0.2' }[symbol] || '0') : String(Math.floor(1e8 / saved.length) / 1e8);
      invalidateBacktest();
    });
    // Changing the active universe's leading asset needs an explicit new date review.
    $('portfolio-weights').addEventListener('input', () => {
      $('backtest-status').textContent = 'Weights changed. Dates are not shifted automatically; preview validates selected assets and dates.';
    });
    const copySimple = () => {
      const rule = kind => ({ left: $(`criteria-${kind}-left`).value, op: $(`criteria-${kind}-op`).value,
        right: $(`criteria-${kind}-right`).value.trim() });
      $('criteria-advanced-json').value = json({ entry: rule('entry'), exit: rule('exit') });
    };
    copySimple();
    $('criteria-copy-simple').addEventListener('click', () => { copySimple(); $('criteria-advanced-enabled').checked = true; invalidateBacktest(); });
    for (const kind of ['entry', 'exit']) {
      for (const [value, text] of [['gte', 'At least (≥)'], ['lte', 'At most (≤)'], ['eq', 'Equal (=)']]) {
        const option = node('option', text); option.value = value; $(`criteria-${kind}-op`).append(option);
      }
    }

    // Shared progress lives outside the switched views; hiding charts never hides the bar.
    let partial = { strategy: [], benchmark: [] }, totals = {}, progressIdentity = '';
    const svgNode = (tag, attrs = {}, text) => {
      const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      if (text !== undefined) element.textContent = text;
      return element;
    };
    function livePlot() {
      const svg = $('backtest-live-performance'), width = svg.getBoundingClientRect().width;
      if (!width) return;
      svg.setAttribute('viewBox', `0 0 ${width} 180`);
      const metrics = [['backtest-live-cagr', 'cagr'], ['backtest-live-mdd', 'max_drawdown']];
      const groups = metrics.map(([id, key]) => {
        const group = $(id);
        group.replaceChildren();
        group.dataset.metric = key;
        group.dataset.points = Object.values(partial).flat().filter(point => numeric(point[key])).length;
        return group;
      });
      svg.replaceChildren(...groups);
      const right = width - 16;
      const points = Object.values(partial).flat();
      const dates = [...new Set(points.map(point => point.date))].sort();
      const values = points.flatMap(point => metrics.map(([, key]) => point[key])).filter(numeric).map(Number);
      delete svg.dataset.axisMin; delete svg.dataset.axisMax;
      if (!values.length) { svg.append(svgNode('text', { x: 20, y: 60, class: 'chart-axis-label' }, 'Waiting for backend metrics')); return; }
      let low = Math.min(0, ...values), high = Math.max(0, ...values);
      if (low === high) { low -= .01; high += .01; }
      svg.dataset.axisMin = low; svg.dataset.axisMax = high;
      // One unnormalized ratio domain for all four backend series; labels alone use percent.
      const y = value => 150 - (Number(value) - low) / (high - low) * 125;
      const axisLabel = value => {
        const percent = value * 100;
        return `${Math.abs(percent) >= 10000 ? percent.toExponential(1) : price(percent)}%`;
      };
      const left = Math.max(62, ...[low, high].map(value => axisLabel(value).length * 7 + 8));
      const ticks = [low, high];
      if (y(low) - y(0) >= 16 && y(0) - y(high) >= 16) ticks.splice(1, 0, 0);
      for (const value of ticks) {
        const axisY = y(value);
        svg.append(svgNode('line', { x1: left, x2: right, y1: axisY, y2: axisY, class: 'chart-grid-line' }),
          svgNode('text', { x: 2, y: axisY + 4, class: 'chart-axis-label' }, axisLabel(value)));
      }
      for (const [metricIndex, [, key]] of metrics.entries()) {
        const group = groups[metricIndex];
        for (const phase of ['strategy', 'benchmark']) {
          let d = '', connected = false;
          for (const [index, point] of partial[phase].entries()) {
            if (!numeric(point[key])) { connected = false; continue; }
            if (point.completed !== partial[phase][index - 1]?.completed + 1) connected = false;
            const x = left + dates.indexOf(point.date) / Math.max(1, dates.length - 1) * (right - left);
            const py = y(point[key]);
            d += `${connected ? 'L' : 'M'}${x},${py} `; connected = true;
            const isolated = !numeric(partial[phase][index - 1]?.[key]) && !numeric(partial[phase][index + 1]?.[key]);
            const dot = svgNode('circle', { cx: x, cy: py, r: 3,
              class: `live-point ${phase}${isolated ? ' only-point' : ''}`,
              'data-portfolio': phase, 'data-phase': phase, 'data-metric': key,
              'data-date': point.date, 'data-value': point[key] });
            dot.append(svgNode('title', {}, `${phase} · ${point.date} · ${key === 'cagr' ? 'CAGR' : 'MDD'} ${pct(point[key])}`));
            group.append(dot);
          }
          group.prepend(svgNode('path', { d, class: `live-line ${phase}`, 'data-phase': phase, 'data-metric': key }));
        }
      }
      svg.append(...groups); // Keep grid lines behind the backend curves.
      svg.append(svgNode('text', { x: left, y: 175, class: 'chart-axis-label' }, dates[0]),
        svgNode('text', { x: right, y: 175, 'text-anchor': 'end', class: 'chart-axis-label' }, dates.at(-1)));
    }
    new ResizeObserver(livePlot).observe($('backtest-live-performance'));
    function beginProgress(spec) {
      partial = { strategy: [], benchmark: [] }; totals = {};
      progressIdentity = `Archive ${spec.archive_id} · ${spec.start} — ${spec.end}`;
      $('backtest-progress-panel').hidden = false;
      $('backtest-progress-panel').dataset.state = 'running';
      $('backtest-progress-status').textContent = 'Running';
      for (const phase of ['strategy', 'benchmark']) {
        $(`backtest-${phase}-completed`).textContent = '—';
        $(`backtest-${phase}-total`).textContent = '—';
      }
      $('backtest-progress-detail').textContent = `${progressIdentity} · Waiting for backend session progress (— = unknown)`;
      $('backtest-progress').value = 0;
      livePlot();
    }
    function progress(point) {
      const previous = partial[point.phase].at(-1);
      if (previous && (point.completed < previous.completed || point.total !== previous.total)) throw new Error('Backend progress decreased or the total session count changed.');
      if (previous?.completed === point.completed) partial[point.phase].pop();
      partial[point.phase].push(point); totals[point.phase] = point;
      const denominator = (totals.strategy?.total || point.total) + (totals.benchmark?.total || point.total);
      $('backtest-progress').value = ((totals.strategy?.completed || 0) + (totals.benchmark?.completed || 0)) / denominator;
      // Keep both labels and numeric slots mounted. Only lifecycle changes are announced.
      $(`backtest-${point.phase}-completed`).textContent = String(point.completed);
      $(`backtest-${point.phase}-total`).textContent = String(point.total);
      $('backtest-progress-detail').textContent = `${progressIdentity} · ${point.date} · NAV ${numeric(point.nav) ? price(point.nav) : 'Unavailable'} · CAGR ${pct(point.cagr)} · MDD ${pct(point.max_drawdown)}`;
      livePlot();
    }
    function finishProgress(text, failed = false) {
      $('backtest-progress-status').textContent = text;
      $('backtest-progress-panel').dataset.state = failed ? 'error' : 'complete';
      // A terminal result is authoritative completion. Failure retains only actual progress.
      if (!failed) $('backtest-progress').value = 1;
    }
    $('backtest-live-toggle').addEventListener('click', () => {
      const hidden = !$('backtest-live-charts').hidden;
      $('backtest-live-charts').hidden = hidden;
      $('backtest-live-toggle').setAttribute('aria-expanded', String(!hidden));
      $('backtest-live-toggle').textContent = hidden ? 'Show progress charts' : 'Hide progress charts';
    });

    function table(parent, headings, rows, label) {
      const table = node('table'); table.setAttribute('aria-label', label);
      const head = node('thead'), tr = node('tr');
      for (const title of headings) { const th = node('th', title); th.scope = 'col'; tr.append(th); }
      head.append(tr); table.append(head);
      const body = node('tbody');
      for (const cells of rows) {
        const row = node('tr');
        for (const cell of cells) row.append(node('td', cell ?? 'Unavailable'));
        body.append(row);
      }
      if (!rows.length) { const row = node('tr'), cell = node('td', 'No records returned.'); cell.colSpan = headings.length; row.append(cell); body.append(row); }
      table.append(body); parent.replaceChildren(table);
    }
    const limitationText = text => {
      if (text.startsWith('Current Yahoo price snapshot')) return 'Current Yahoo price snapshot; historical information availability is unverified. Survivorship bias and historical universe completeness are also unverified.';
      if (text.startsWith('Price returns only')) return 'Price returns only, not dividend total return. Splits and dividends are not applied again.';
      if (text.startsWith('Aligned saved sessions')) return 'Aligned saved sessions do not validate the exchange calendar. Shared missing dates are not detected; the latest bar may be incomplete.';
      if (text.startsWith('Correlation is descriptive')) return 'Correlation describes observed co-movement, not causation or prediction. Partial boundary weeks or months may have shorter return periods.';
      if (text.startsWith('Retrospective event study')) return 'Retrospective event study, not a trading backtest or evidence of causation. Future prices are used only for the stated retrospective outcomes.';
      if (text.startsWith('Overlapping samples')) return 'Overlapping samples are not independent. No significance tests or multiple-testing corrections are provided.';
      if (text.startsWith('User-imported normalized holdings')) return 'User-imported normalized holdings, not SEC-certified data. Only source URL syntax is checked; no network lookup, filing authentication or curated fund dataset is provided.';
      if (text.startsWith('13F filings generally')) return '13F filings generally arrive up to 45 days after quarter-end and may be late or amended. Supplied filed_at ≤ as_of is applied at date level; intraday publication time and historical authenticity are not verified.';
      if (text.startsWith('This normalized analysis')) return 'This analysis covers disclosed long US equity holdings, not full portfolios. Shorts, cash, derivatives and non-US holdings are excluded. Actual 13F coverage includes some options and ADRs; do not combine different instruments as common-share quantities.';
      if (text.startsWith('Quarter-end holdings')) return 'Quarter-end holdings cannot establish trade dates, fill prices, dividends, cash flows, fees or realized returns. No fund returns, estimated performance, CAGR or MDD are generated.';
      if (text.startsWith('Comparisons use each')) return 'Compare each manager\'s latest and previous available supplied periods, not assumed consecutive quarters. Without a previous filing, changes are unknown, not new. New/exited reflect supplied row presence, not actual buys/sells. Omissions, confidential treatment, splits and identifier changes can affect results.';
      if (text.startsWith('Popularity counts')) return 'Common holdings count distinct exact manager IDs in their latest available filings, not all managers or a 79-fund sample. Manager dates may differ. Amounts are supplied quarter-end USD, not current values or thousands of dollars. Weights use imported holdings only; a zero total gives zero weights. Zero rows are retained.';
      if (text.startsWith('Identifiers must')) return 'Normalize identifiers before import. Duplicate manager/period pairs and duplicate CUSIPs within a filing are rejected. Rows are grouped by CUSIP; conflicting names use the first manager alphabetically. This is not authenticated security reference data.';
      return text;
    };
    const limitations = (id, items) => $(id).replaceChildren(...(Array.isArray(items) ? items : ['Limitations unavailable.']).map(item => node('li', limitationText(item))));
    function invalidateTrigger(force = false) {
      // The main controller invalidates Backtest often; independent studies do not depend on it.
      if (!force && !usesBacktest()) return;
      triggerRevision++; triggerResult = null; $('trigger-result').hidden = true; setError('trigger-error');
      $('trigger-status').textContent = 'Input or source changed. Analyze again with the current condition and dates.';
      updateTriggerControls();
    }
    for (const type of ['input', 'change']) {
      $('trigger-form').addEventListener(type, () => { invalidateTrigger(true); syncTriggerInputs(); });
      $('backtest-form').addEventListener(type, () => { if (usesBacktest()) { invalidateTrigger(true); syncTriggerInputs(); } });
    }
    $('trigger-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (triggerBusy || !archive || state.marketBusy) return;
      invalidateTrigger(true);
      const revision = triggerRevision;
      try {
        const spec = triggerSpec(), { horizons } = spec;
        const requested = JSON.stringify(spec);
        triggerBusy = true; updateTriggerControls();
        $('trigger-status').textContent = 'Evaluating the condition and calculating retrospective returns';
        const result = await api('market.trigger', { spec });
        if (revision !== triggerRevision || archive !== spec.archive_id || JSON.stringify(triggerSpec()) !== requested) return;
        const ratio = value => value === null || typeof value === 'string' && numeric(value);
        if (result?.archive_id !== spec.archive_id || result.symbol !== spec.symbol || result.target_symbol !== spec.target_symbol
          || result.analysis_type !== 'retrospective_event_study_not_tradable_backtest' || result.contract?.version !== 'trigger-v1'
          || result.spec?.start !== spec.start || result.spec?.end !== spec.end
          || !Array.isArray(result.summary) || result.summary.length !== horizons.length
          || result.summary.some((row, i) => row.horizon !== horizons[i] || !Number.isInteger(row.n) || row.n < 0
            || ![row.mean, row.median, row.win_rate].every(ratio) || typeof row.overlapping_samples !== 'boolean')
          || !Array.isArray(result.events) || result.event_count !== result.events.length
          || result.events.some(event => !Array.isArray(event.outcomes) || event.outcomes.length !== horizons.length
            || event.outcomes.some((outcome, i) => outcome.horizon !== horizons[i] || !ratio(outcome.return)))) {
          throw new Error('Invalid event-analysis response. No substitute results are displayed.');
        }
        table($('trigger-summary'), ['Forward sessions', 'Complete samples n', 'Mean', 'Median', 'Win rate', 'Overlap'], result.summary.map(row =>
          [row.horizon, row.n, pct(row.mean), pct(row.median), pct(row.win_rate), row.overlapping_samples ? 'Yes · not independent' : 'None']), 'Retrospective return summary by horizon');
        table($('trigger-events'), ['Event date', 'Forward sessions', 'Entry date', 'Exit date', 'Target open', 'Target close', 'Return', 'Availability'], result.events.flatMap(event => event.outcomes.map(outcome =>
          [event.date, outcome.horizon, outcome.entry_date, outcome.exit_date, outcome.entry_open, outcome.exit_close, pct(outcome.return),
            outcome.return === null ? 'Unavailable · insufficient forward sessions within the window' : 'Complete'])), 'Retrospective returns by event');
          $('trigger-source').textContent = `Source: saved Yahoo archive ${result.archive_id} · Condition ${result.symbol} → Return ${result.target_symbol} · ${spec.start} — ${spec.end} · ${result.event_count} events · retrospective price returns before costs`;
        $('trigger-contract').textContent = json({ spec: result.spec, contract: result.contract, warnings: result.warnings });
        limitations('trigger-limitations', result.limitations);
        triggerResult = result; $('trigger-result').hidden = false;
        $('trigger-status').textContent = `Analysis complete · ${result.event_count} events · ${result.summary.some(row => row.overlapping_samples) ? 'Overlapping samples · not independent' : 'No overlapping samples'} · not trading-strategy performance.`;
      } catch (error) {
        if (revision === triggerRevision) { setError('trigger-error', errorText(error)); $('trigger-status').textContent = 'Analysis failed · no usable result.'; }
      } finally { triggerBusy = false; syncArchive(); }
    });
    $('correlation-form').addEventListener('input', () => {
      correlationRevision++; $('correlation-result').hidden = true; correlationResult = null;
      $('correlation-status').textContent = 'Inputs changed. Calculate again with the current inputs.';
    });
    $('correlation-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (correlationBusy || !archive || state.marketBusy) return;
      setError('correlation-error'); $('correlation-result').hidden = true;
      const revision = correlationRevision;
      try {
        const selected = parseSymbols($('correlation-symbols').value);
        if (selected.length < 2) throw new Error('Correlation requires at least two assets.');
        if (selected.some(symbol => !symbols().includes(symbol))) throw new Error('All selected assets must be in the current saved data. Fetch missing assets first.');
        const spec = { archive_id: archive, symbols: selected, start: $('correlation-start').value,
          end: $('correlation-end').value, frequency: $('correlation-frequency').value };
        if (!spec.start || !spec.end || spec.start >= spec.end) throw new Error('End date must be after start date.');
        correlationBusy = true; $('correlation-run').disabled = true;
        $('correlation-status').textContent = 'Calculating returns from actual saved prices';
        const result = await api('market.correlation', { spec });
        if (revision !== correlationRevision || archive !== spec.archive_id) return;
        if (!Array.isArray(result?.symbols) || result.symbols.length !== selected.length
          || new Set(result.symbols).size !== selected.length || result.symbols.some(symbol => !selected.includes(symbol))
          || !Array.isArray(result.matrix) || result.matrix.length !== selected.length
          || result.matrix.some(row => !Array.isArray(row) || row.length !== selected.length
            || row.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1)))) {
          throw new Error('Invalid correlation response. No matrix or substitute values are displayed.');
        }
        const head = node('thead'), heading = node('tr'); heading.append(node('th', 'Asset'));
        for (const symbol of result.symbols) { const th = node('th', symbol); th.scope = 'col'; heading.append(th); }
        head.append(heading); const body = node('tbody');
        result.symbols.forEach((symbol, index) => {
          const row = node('tr'), th = node('th', symbol); th.scope = 'row'; row.append(th);
          result.matrix[index].forEach(value => {
            const cell = node('td', value === null ? 'Unavailable' : value.toFixed(3));
            cell.dataset.value = value === null ? 'null' : String(value);
            cell.title = value === null ? 'Insufficient return samples or zero variance · not zero correlation' : String(value);
            if (value !== null) cell.className = value >= 0 ? 'correlation-positive' : 'correlation-negative';
            row.append(cell);
          }); body.append(row);
        });
        $('correlation-table').replaceChildren(head, body);
        $('correlation-source').textContent = `Source: saved Yahoo archive ${spec.archive_id} · Requested window ${spec.start} — ${spec.end} · ${{ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[spec.frequency]} returns. Actual sessions and sample counts follow the calculation contract below. Dates are not adjusted by intersection.`;
        $('correlation-contract').textContent = json({ observations: result.observations, contract: result.contract });
        limitations('correlation-limitations', result.limitations);
        correlationResult = result;
        $('correlation-result').hidden = false; $('correlation-status').textContent = 'Complete · backend calculation, not a browser estimate.';
      } catch (error) {
        if (revision === correlationRevision) { setError('correlation-error', errorText(error)); $('correlation-status').textContent = 'Failed · no usable result. No automatic retry.'; }
      } finally { correlationBusy = false; syncArchive(); }
    });

    // Guru and Quant Swarm are owned by their standalone controllers.
    syncArchive();
    return { show, syncArchive, beginProgress, progress, finishProgress, invalidateTrigger, download };
  };
})();