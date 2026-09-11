/* Automatic read-only Guru dashboard. Public adapter contract: guru-service.js.
 * No fetching outside the injected API, performance calculations or client cache.
 * Provider percentages are percentage points. yearly[end year] is the reported
 * year-to-date value through return_end_period, never the computer's current year.
 */
(() => {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = value => value == null || value === '' ? '—' : String(value);
  const flag = value => value === true || value === 1;
  const format = value => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const percent = value => finite(value) ? `${format(value)}%` : '—';
  const usd = value => finite(value) ? `$${format(value)}` : '—';
  const style = fund => fund.category_en || fund.category || null;
  const ytd = fund => /^\d{4}-\d{2}-\d{2}$/.test(fund.return_end_period || '')
    ? fund.returns?.yearly?.[fund.return_end_period.slice(0, 4)] ?? null : null;
  const changeNames = { NEW: 'New', INC: 'Increased', DEC: 'Decreased', SOLD: 'Sold out' };
  const metrics = [
    ['ytd', 'YTD', ytd], ['1y', '1Y total', f => f.returns?.['1y_total']],
    ['3y', '3Y annualized', f => f.returns?.['3y_annualized']],
    ['5y', '5Y annualized', f => f.returns?.['5y_annualized']],
    ['since', 'Since start annualized', f => f.returns?.inception_annualized],
  ];

  window.ITTGuru = function ITTGuru({ root, api, node, message, numeric, price }) {
    // Shared helpers are accepted for host compatibility; rendering deliberately
    // uses DOM text nodes and strict number checks rather than coercive formatters.
    if (!root || typeof api !== 'function') throw new TypeError('Guru requires root and api.');
    const doc = root.ownerDocument;
    let visible = false, version = 0, ready = false;
    let fundsResult, quartersResult, currentResult;
    const state = { view: 'overview', id: '', period: '', detailPeriod: '', mode: 'popular', type: '', cik: '', includeIndex: false };
    const tableState = new Map();
    const overview = { query: '', universe: 'default', category: '' };

    function el(tag, content, className) {
      const item = doc.createElement(tag);
      if (content != null) item.textContent = String(content);
      if (className) item.className = className;
      return item;
    }
    function button(label, handler, id) {
      const item = el('button', label);
      item.type = 'button';
      if (id) item.id = id;
      item.addEventListener('click', handler);
      return item;
    }
    function select(label, id, values, value, handler) {
      const wrap = el('label', label, 'guru-field');
      const input = el('select'); input.id = id;
      for (const [key, title] of values) {
        const option = el('option', title); option.value = key; input.append(option);
      }
      input.value = value;
      input.addEventListener('change', () => handler(input.value));
      wrap.append(input); return wrap;
    }
    function search(label, id, value, handler) {
      const wrap = el('label', label, 'guru-field guru-search');
      const input = el('input'); input.type = 'search'; input.id = id; input.value = value;
      input.placeholder = label;
      input.addEventListener('input', () => handler(input.value));
      wrap.append(input); return wrap;
    }
    function checkbox(label, id, checked, handler) {
      const wrap = el('label', null, 'guru-check');
      const input = el('input'); input.type = 'checkbox'; input.id = id; input.checked = checked;
      input.addEventListener('change', () => handler(input.checked));
      wrap.append(input, doc.createTextNode(label)); return wrap;
    }
    const funds = () => fundsResult?.data.funds || [];
    const quarters = () => quartersResult?.data.quarters || [];
    const match = (query, values) => values.some(value => value != null && String(value).toLowerCase().includes(query.trim().toLowerCase()));

    root.classList.add('itt-guru'); root.hidden = true; root.replaceChildren();
    const header = el('header', null, 'guru-header');
    const heading = el('div'); heading.append(el('h2', 'Guru Funds'));
    header.append(heading);
    const warning = el('p', 'Estimated performance, not actual fund returns. Delayed 13F snapshots; not a point-in-time backtest.', 'guru-warning');
    warning.id = 'guru-estimate-warning';
    const tabs = el('div', null, 'guru-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Guru views');
    const tabButtons = [];
    for (const [key, label] of [['overview', 'Overview'], ['detail', 'Fund detail'], ['popular', 'Popular stocks'], ['changes', 'Recent changes']]) {
      const item = button(label, () => switchView(key), `guru-tab-${key}`);
      item.setAttribute('role', 'tab'); item.setAttribute('aria-controls', 'guru-panel');
      item.addEventListener('keydown', event => {
        const index = tabButtons.indexOf(item);
        const next = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : null;
        if (next !== null) { event.preventDefault(); tabButtons[next].focus(); tabButtons[next].click(); }
      });
      tabs.append(item); tabButtons.push(item);
    }
    const status = el('p', null, 'guru-status'); status.id = 'guru-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const panel = el('section'); panel.id = 'guru-panel'; panel.setAttribute('role', 'tabpanel');
    panel.tabIndex = 0;
    const controls = el('div', null, 'guru-controls'); controls.id = 'guru-controls';
    const results = el('div'); results.id = 'guru-results';
    const provenance = el('footer', null, 'guru-provenance'); provenance.id = 'guru-provenance';
    header.append(tabs, button('Refresh', () => reload(true), 'guru-refresh'));
    const navigation = el('div', null, 'guru-navigation'); navigation.append(warning, status);
    panel.append(controls, results, provenance); root.append(header, navigation, panel);

    // Size only the primary table against its real host, not a fixed 640px cap.
    // Outer scroll offsets are added back so scrolling to notes cannot resize it.
    let layoutFrame;
    function fitTable() {
      doc.defaultView.cancelAnimationFrame(layoutFrame);
      layoutFrame = doc.defaultView.requestAnimationFrame(() => {
        if (!visible) return;
        const surface = results.querySelector('.guru-table-scroll');
        if (!surface) return;
        let top = surface.getBoundingClientRect().top;
        let bottom = doc.defaultView.innerHeight;
        for (let parent = surface.parentElement; parent; parent = parent.parentElement) {
          const css = doc.defaultView.getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
            top += parent.scrollTop;
            bottom = Math.min(bottom, parent.getBoundingClientRect().bottom);
          }
        }
        const pagination = surface.nextElementSibling;
        const footerHeight = pagination.getBoundingClientRect().height + 8;
        surface.style.maxHeight = `${Math.max(320, Math.floor(bottom - top - footerHeight))}px`;
      });
    }
    const resize = new doc.defaultView.ResizeObserver(fitTable);
    resize.observe(root);
    if (root.parentElement) resize.observe(root.parentElement);
    doc.defaultView.addEventListener('resize', fitTable);

    function announce(value, busy = false) {
      status.textContent = value; panel.setAttribute('aria-busy', String(busy));
    }
    function syncTabs() {
      for (const item of tabButtons) {
        const selected = item.id === `guru-tab-${state.view}`;
        item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
      }
      panel.setAttribute('aria-labelledby', `guru-tab-${state.view}`);
    }
    function sourceInfo(entries) {
      provenance.replaceChildren();
      for (const [label, entry] of entries) {
        if (!entry) continue;
        const source = entry.source || {};
        const line = el('p'); line.append(doc.createTextNode(`${label} · `));
        let url;
        try { const parsed = new URL(source.url); if (parsed.protocol === 'https:') url = parsed.href; } catch { /* Unknown URL remains plain text. */ }
        if (url) {
          const link = el('a', `${text(source.provider)} · ${url}`); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; line.append(link);
        } else line.append(doc.createTextNode(text(source.provider)));
        line.append(doc.createTextNode(` · Fetched: ${text(source.fetchedAt)} · Local cache: ${source.cached === true ? 'yes' : source.cached === false ? 'no' : 'unknown'} · Cache age: ${format(source.cacheAgeSeconds)} s · Upstream cache age: ${format(source.upstreamCacheAgeHours)} h`));
        provenance.append(line);
      }
      const details = el('details'); details.id = 'guru-caveats'; details.append(el('summary', 'Provider notes and data limitations'));
      details.append(el('p', 'Estimated performance, not actual fund returns. Delayed 13F snapshots omit intraperiod trades and parts of the portfolio. Not a point-in-time backtest.'));
      const notes = new Set(entries.flatMap(([, entry]) => [entry?.data?.note, ...(entry?.limitations || [])]).filter(value => typeof value === 'string' && value));
      for (const note of notes) details.append(el('p', note));
      details.append(el('p', 'Refresh requests the public feed again; it does not trigger upstream collection. Missing values are shown as —.'));
      provenance.append(details);
    }

    // Each table has its own local, bounded pagination. Missing values stay last
    // in both directions; no Number(null), synthesized zero, or financial math.
    function table(host, key, caption, rows, columns, { query = false, defaultSort, defaultDesc = false, onActivate } = {}) {
      const saved = tableState.get(key) || { page: 0, size: 30, query: '', sort: defaultSort, desc: defaultDesc };
      tableState.set(key, saved);
      const wrap = el('section', null, 'guru-table-section');
      const surface = el('div', null, 'guru-table-scroll'); surface.tabIndex = 0; surface.setAttribute('aria-label', `${caption} table, horizontally scrollable`);
      const navigation = el('div', null, 'guru-pagination');
      if (query) (host === results ? controls : wrap).append(search('Search ticker or company', `guru-${key}-search`, saved.query, value => { saved.query = value; saved.page = 0; draw(); }));
      wrap.append(surface, navigation); host.append(wrap);
      function draw() {
        let filtered = query ? rows.filter(row => match(saved.query, [row.ticker, row.name])) : [...rows];
        const sortColumn = columns.find(column => column.key === saved.sort);
        if (sortColumn) filtered.sort((a, b) => {
          const left = sortColumn.value(a), right = sortColumn.value(b);
          const missing = value => value == null || value === '' || (typeof value === 'number' && !finite(value));
          if (missing(left)) return missing(right) ? 0 : 1;
          if (missing(right)) return -1;
          const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'en');
          return saved.desc ? -result : result;
        });
        const pages = Math.max(1, Math.ceil(filtered.length / saved.size)); saved.page = Math.min(saved.page, pages - 1);
        const grid = el('table'); grid.id = `guru-${key}-table`; grid.append(el('caption', caption));
        const thead = el('thead'), tr = el('tr');
        for (const column of columns) {
          const th = el('th'); th.scope = 'col';
          th.dataset.column = column.key;
          th.setAttribute('aria-sort', saved.sort === column.key ? saved.desc ? 'descending' : 'ascending' : 'none');
          const sort = button(column.label, () => {
            saved.desc = saved.sort === column.key ? !saved.desc : false;
            saved.sort = column.key; saved.page = 0; draw();
            surface.querySelector(`[data-sort="${column.key}"]`)?.focus();
          });
          sort.dataset.sort = column.key; th.append(sort); tr.append(th);
        }
        thead.append(tr); grid.append(thead);
        const tbody = el('tbody');
        for (const row of filtered.slice(saved.page * saved.size, (saved.page + 1) * saved.size)) {
          const line = el('tr');
          if (onActivate) {
            line.classList.add('guru-clickable-row');
            // The manager button supplies native keyboard access; clicking any
            // other cell opens the same fund without duplicating button events.
            line.addEventListener('click', event => {
              if (!event.target.closest('button, a, input, select')) onActivate(row);
            });
          }
          for (const column of columns) {
            const cell = el('td'); const value = column.value(row);
            cell.dataset.column = column.key;
            if (column.format) cell.classList.add('guru-number');
            if (column.render) column.render(cell, row);
            else cell.textContent = column.format ? column.format(value) : text(value);
            if (column.format === percent && finite(value) && value !== 0) cell.classList.add(value < 0 ? 'guru-negative' : 'guru-positive');
            line.append(cell);
          }
          tbody.append(line);
        }
        if (!filtered.length) { const line = el('tr'), cell = el('td', 'No matching records.'); cell.colSpan = columns.length; line.append(cell); tbody.append(line); }
        grid.append(tbody); surface.replaceChildren(grid);
        const previous = button('Previous', () => { saved.page--; draw(); navigation.querySelector('button')?.focus(); }); previous.disabled = saved.page === 0;
        const next = button('Next', () => { saved.page++; draw(); navigation.querySelectorAll('button')[1]?.focus(); }); next.disabled = saved.page + 1 >= pages;
        const size = select('Rows per page', `guru-${key}-page-size`, [['30', '30'], ['50', '50']], String(saved.size), value => { saved.size = Number(value); saved.page = 0; draw(); });
        const count = el('span', `${filtered.length} records · Page ${saved.page + 1} of ${pages}`); count.setAttribute('role', 'status');
        navigation.replaceChildren(previous, count, next, size);
        fitTable();
      }
      draw();
    }
    const col = (key, label, value = row => row[key], formatter) => ({ key, label, value, format: formatter });
    function openFund(id) { state.id = id; state.detailPeriod = ''; switchView('detail'); }
    function fundButton(cell, row) {
      const link = button(text(row.manager || row.name), () => openFund(row.cik)); link.className = 'guru-fund-link'; link.dataset.fundId = row.cik;
      cell.append(link);
    }
    function returnColumns() { return metrics.map(([key, label, value]) => col(key, `${label} (est.)`, value, percent)); }

    function renderOverview() {
      const list = funds();
      const defaultCount = list.filter(f => flag(f.active) && flag(f.show_in_default)).length;
      const tableHost = el('div');
      const count = el('p', `${defaultCount} default active funds / ${list.length} total.`, 'guru-summary');
      count.title = 'Default requires both active and show_in_default provider flags.';
      results.append(tableHost, count);
      function draw() {
        const filtered = list.filter(f => (overview.universe === 'all' || (flag(f.active) && (overview.universe === 'active' || flag(f.show_in_default)))))
          .filter(f => !overview.category || style(f) === overview.category)
          .filter(f => match(overview.query, [f.name, f.manager, f.cik]));
        tableHost.replaceChildren();
        table(tableHost, 'funds', 'Fund overview · estimated returns, USD holdings', filtered, [
          { ...col('manager', 'Manager'), render: fundButton },
          { ...col('name', 'Fund / style'), render: (cell, f) => { cell.append(el('strong', f.name), el('small', text(style(f)), 'guru-muted')); } },
          { ...col('range', 'Return coverage', f => f.return_start_period), render: (cell, f) => {
            cell.append(el('span', `${text(f.return_start_period)} → ${text(f.return_end_period)}`), el('small', `Holdings: ${text(f.latest_period)}`, 'guru-muted'));
          } },
          ...returnColumns(),
          { ...col('reliability', 'Provider reliability', f => f.reliability_label), render: (cell, f) => {
            cell.append(el('span', `${text(f.reliability_label)} · Quality: ${text(f.quality_tag)}`), el('small', `Returns current: ${text(f.returns_current)}`, 'guru-muted'));
          } },
        ], { defaultSort: 'since', defaultDesc: true, onActivate: f => openFund(f.cik) });
      }
      const resetDraw = () => { const saved = tableState.get('funds'); if (saved) saved.page = 0; draw(); };
      controls.append(
        search('Search manager or fund', 'guru-fund-search', overview.query, value => { overview.query = value; resetDraw(); }),
        select('Fund universe', 'guru-universe', [['default', 'Default active funds'], ['active', 'All active funds'], ['all', 'All funds']], overview.universe, value => { overview.universe = value; resetDraw(); }),
        select('Style', 'guru-style', [['', 'All styles'], ...[...new Set(list.map(style).filter(Boolean))].sort().map(value => [value, value])], overview.category, value => { overview.category = value; resetDraw(); }),
      );
      results.append(el('p', 'YTD is the provider’s yearly value for the return-end year, through that end date. 1Y is total return; 3Y, 5Y and since-start are annualized. A missing horizon stays unavailable.', 'guru-muted'));
      draw(); sourceInfo([['Funds', fundsResult], ['Quarters', quartersResult]]);
    }
    function renderQuarterControls() {
      controls.append(select('Reporting quarter', 'guru-quarter', quarters().map(q => [q.period, q.period]), state.period, value => { state.period = value; void loadView(); }));
      controls.append(checkbox('Include index funds', 'guru-include-index', state.includeIndex, value => { state.includeIndex = value; void loadView(); }));
    }
    function renderControls() {
      controls.replaceChildren();
      if (state.view === 'detail') {
        controls.append(select('Fund', 'guru-detail-fund', funds().map(f => [f.cik, `${text(f.manager)} · ${f.name}`]), state.id, value => { state.id = value; state.detailPeriod = ''; currentResult = null; void loadView(); }));
        const periods = currentResult?.data?.periods_available || [];
        if (periods.length) controls.append(select('Holdings quarter', 'guru-detail-quarter', periods.map(p => [p, p]), state.detailPeriod || currentResult.data.period, value => { state.detailPeriod = value; void loadView(); }));
      } else if (state.view === 'popular' || state.view === 'changes') {
        renderQuarterControls();
        if (state.view === 'popular') controls.append(select('View', 'guru-popular-mode', [['popular', 'Holdings'], ['buys', 'Big buys'], ['sells', 'Big sells']], state.mode, value => { state.mode = value; void loadView(); }));
        else controls.append(
          select('Change type', 'guru-change-type', [['', 'All changes'], ...Object.entries(changeNames)], state.type, value => { state.type = value; void loadView(); }),
          select('Fund', 'guru-change-fund', [['', 'All funds'], ...funds().map(f => [f.cik, `${text(f.manager)} · ${f.name}`])], state.cik, value => { state.cik = value; void loadView(); }),
        );
      }
    }
    function renderDetail(data) {
      table(results, 'holdings', `Reported holdings · ${text(data.period)}`, data.holdings, [
        col('ticker', 'Ticker'), col('name', 'Company'), col('value', 'Value (USD)', undefined, usd), col('shares', 'Shares', undefined, format),
        col('weight', 'Weight', h => h.pct_portfolio, percent), col('change_type', 'Change', h => changeNames[h.change_type] || h.change_type), col('pct_change', 'Share change', undefined, percent),
      ], { query: true, defaultSort: 'value', defaultDesc: true });
      results.append(el('h3', `${text(data.fund.manager)} · ${data.fund.name}`));
      const summary = el('div', null, 'guru-summary'); summary.id = 'guru-detail-summary';
      for (const value of [
        `Holdings as of: ${text(data.period)}`,
        `Latest filed quarter: ${text(data.latest_filed_period)} · Latest market quarter: ${text(data.latest_market_period)}`,
        `Filing status: ${text(data.filing_status)} · Empty filing: ${text(data.is_empty_filing)}`,
        `Reported portfolio value: ${usd(data.total_value)} · Positions: ${format(data.position_count)}`,
        `Provider reliability: ${text(data.fund.reliability_label)} · Quality: ${text(data.fund.quality_tag)}`,
      ]) summary.append(el('p', value));
      results.append(summary);
      const performance = el('section', null, 'guru-performance'); performance.id = 'guru-performance';
      performance.append(el('h3', 'Provider-reported estimated performance'), el('p', `Return coverage: ${text(data.return_start_period)} → ${text(data.return_end_period)} · Returns current: ${text(data.returns_current)}`));
      performance.append(el('p', 'Return coverage is independent of the selected holdings quarter and may end later. These are not actual fund returns.', 'guru-warning'));
      const cards = el('dl', null, 'guru-metrics');
      for (const [, label, value] of metrics) { const card = el('div'); card.append(el('dt', label), el('dd', percent(value(data)))); cards.append(card); }
      performance.append(cards);
      const yearly = Object.entries(data.returns?.yearly || {}).filter(([year, value]) => /^\d{4}$/.test(year) && finite(value)).sort(([a], [b]) => a.localeCompare(b));
      if (yearly.length) {
        const details = el('details'); details.append(el('summary', 'Reported yearly estimates'));
        const list = el('dl', null, 'guru-metrics');
        for (const [year, value] of yearly) { const item = el('div'); item.append(el('dt', `${year}${data.return_end_period?.startsWith(year) ? ' (through return end)' : ''}`), el('dd', percent(value))); list.append(item); }
        details.append(list); performance.append(details);
      }
      // A weight chart, not a fabricated return curve. The adjacent table retains
      // exact values even if an anomalous provider weight is outside 0..100.
      const bars = el('section', null, 'guru-holdings-bars'); bars.id = 'guru-holdings-bars'; bars.append(el('h3', 'Largest reported holdings · portfolio weight'));
      const weighted = data.holdings.filter(h => finite(h.pct_portfolio)).sort((a, b) => b.pct_portfolio - a.pct_portfolio).slice(0, 10);
      for (const holding of weighted) {
        const row = el('div', null, 'guru-bar-row'); const label = `${text(holding.ticker || holding.name)} · ${percent(holding.pct_portfolio)}`;
        const meter = el('meter'); meter.min = 0; meter.max = 100; meter.value = holding.pct_portfolio; meter.setAttribute('aria-label', label);
        row.append(el('span', label), meter); bars.append(row);
      }
      if (!weighted.length) bars.append(el('p', 'Portfolio weights unavailable. No chart generated.'));
      const secondary = el('div', null, 'guru-secondary'); secondary.append(performance, bars); results.append(secondary);
    }
    function renderFilingStatus(data) {
      const counts = el('p', `Filed: ${format(data.filed_count)} · Not filed: ${format(data.not_filed_count)} · Reporting quarter: ${text(data.period)}`, 'guru-summary'); counts.id = 'guru-filed-counts'; results.append(counts);
      if (Array.isArray(data.fund_status)) {
        const details = el('details'); details.id = 'guru-filing-status'; details.append(el('summary', 'Fund filing status · provider coverage'));
        details.append(el('p', 'Coverage status is supplied by the provider and may include funds outside the selected result filters.', 'guru-muted'));
        table(details, 'filing', 'Provider filing coverage', data.fund_status, [
          col('manager', 'Manager'), col('name', 'Fund'), col('filing_status', 'Status'), col('latest_filed_period', 'Latest filed quarter'),
          col('is_index', 'Index fund'), col('is_empty_filing', 'Empty filing'), col('position_count', 'Positions', undefined, format), col('total_value', 'Value (USD)', undefined, usd),
        ]); return details;
      }
    }
    function renderPopular(data) {
      const filing = renderFilingStatus(data);
      table(results, 'popular', `${{ popular: 'Holdings', buys: 'Big buys', sells: 'Big sells' }[state.mode]} · ${data.period}`, data.manager_funds, [
        col('ticker', 'Ticker'), col('name', 'Company'), col('manager_count', 'Managers', undefined, format), col('total_value', 'Reported value (USD)', undefined, usd), col('total_shares', 'Reported shares', undefined, format),
        { ...col('holders', 'Top holders', row => row.top_holders?.[0]?.manager), render: (cell, row) => {
          for (const holder of (row.top_holders || []).slice(0, 10)) { const line = el('div'); line.append(el('span', `${text(holder.manager)} · ${text(holder.fund)} · ${usd(holder.value)}`)); cell.append(line); }
          if (row.top_holders?.length > 10) cell.append(el('small', 'Showing the first 10 reported holders.', 'guru-muted'));
          if (!row.top_holders?.length) cell.textContent = '—';
        } },
      ], { query: true });
      results.append(doc.getElementById('guru-filed-counts'));
      results.append(el('p', 'Up to 30 provider-ranked stocks. Values are reported holdings, not execution prices or confirmed trade proceeds.', 'guru-muted'));
      if (filing) results.append(filing);
    }
    function renderChanges(data) {
      const filing = renderFilingStatus(data);
      table(results, 'changes', `Recent reported changes · ${data.period}`, data.changes, [
        { ...col('manager', 'Manager'), render: fundButton }, col('fund_name', 'Fund'), col('ticker', 'Ticker'), col('name', 'Company'), col('period', 'Holdings quarter'),
        col('change_type', 'Change', row => changeNames[row.change_type] || row.change_type), col('prev_shares', 'Previous shares', undefined, format),
        col('new_shares', 'Reported shares', undefined, format), col('pct_change', 'Share change', undefined, percent), col('value', 'Value (USD)', undefined, usd),
      ], { query: true });
      results.append(doc.getElementById('guru-filed-counts'));
      results.append(el('p', 'Up to 200 provider records per request; local search and pages cover only this returned set. Share changes do not establish trade dates or prices.', 'guru-muted'));
      if (filing) results.append(filing);
    }
    function renderResult() {
      results.replaceChildren(); renderControls();
      if (state.view === 'overview') renderOverview();
      else {
        const data = currentResult.data;
        if (state.view === 'detail') renderDetail(data);
        else if (state.view === 'popular') renderPopular(data);
        else renderChanges(data);
        sourceInfo([['Result', currentResult], ['Quarters', quartersResult]]);
      }
      announce('Loaded.');
    }
    function errorState(error, retry) {
      results.replaceChildren(el('p', `Unable to load Guru data. ${text(error?.message)}`, 'guru-error'), button('Retry', retry, 'guru-retry'));
      results.firstChild.setAttribute('role', 'alert'); provenance.replaceChildren(); announce('Load failed. No substitute data used.');
    }
    async function bootstrap(refresh = false) {
      const ticket = ++version; ready = false; currentResult = null;
      controls.replaceChildren(); results.replaceChildren(); provenance.replaceChildren(); syncTabs(); announce('Loading funds and reporting quarters…', true);
      try {
        const p = refresh ? { refresh: true } : {};
        const [f, q] = await Promise.all([api('guru.funds', { ...p }), api('guru.quarters', { ...p })]);
        if (!visible || ticket !== version) return;
        fundsResult = f; quartersResult = q; ready = true;
        if (!quarters().some(row => row.period === state.period)) state.period = q.data.default_period || quarters()[0]?.period || '';
        if (!funds().some(row => row.cik === state.id)) { state.id = ''; state.detailPeriod = ''; }
        await loadView(refresh);
      } catch (error) { if (visible && ticket === version) errorState(error, () => bootstrap(refresh)); }
    }
    async function loadView(refresh = false) {
      const ticket = ++version; syncTabs();
      if (!ready) return;
      results.replaceChildren(); provenance.replaceChildren();
      if (state.view === 'overview') { currentResult = null; renderResult(); return; }
      if (state.view === 'detail' && !state.id) state.id = funds().find(f => flag(f.active) && flag(f.show_in_default))?.cik || funds()[0]?.cik || '';
      renderControls();
      if ((state.view === 'detail' && !state.id) || (state.view !== 'detail' && !state.period)) {
        results.append(el('p', state.view === 'detail' ? 'No funds available.' : 'No reporting quarters available.'));
        announce('No data available.'); return;
      }
      const method = state.view === 'detail' ? 'guru.fund' : state.view === 'popular' ? 'guru.popular' : 'guru.changes';
      let params;
      if (state.view === 'detail') params = { id: state.id, ...(state.detailPeriod ? { period: state.detailPeriod } : {}) };
      else params = { period: state.period, include_index: state.includeIndex, limit: state.view === 'popular' ? 30 : 200,
        ...(state.view === 'popular' ? { mode: state.mode } : { ...(state.type ? { type: state.type } : {}), ...(state.cik ? { cik: state.cik } : {}) }) };
      if (refresh) params.refresh = true;
      announce('Loading Guru data…', true);
      try {
        const result = await api(method, params);
        if (!visible || ticket !== version) return;
        currentResult = result; renderResult();
      } catch (error) { if (visible && ticket === version) errorState(error, () => loadView(refresh)); }
    }
    function switchView(view) {
      state.view = view; currentResult = null;
      if (!visible) return;
      if (!ready) { void bootstrap(); return; }
      void loadView();
    }
    function reload(refresh = false) { return !ready || state.view === 'overview' ? bootstrap(refresh) : loadView(refresh); }
    syncTabs();
    return {
      show() {
        if (visible) return;
        visible = true; root.hidden = false;
        return reload();
      },
      hide() {
        visible = false; ++version; root.hidden = true;
        // In-flight work belongs to the adapter. Invalidation prevents every late
        // success/error (including a previous bootstrap) from touching the DOM.
      },
    };
  };
})();