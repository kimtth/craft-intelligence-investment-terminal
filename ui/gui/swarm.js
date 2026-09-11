/* Quant Swarm: authored concept simulation. No network, models, prices or backtests. */
(() => {
  'use strict';
  const DURATION = 60;
  const demoAsset = 'SPY · S&P 500 ETF';
  const families = {
    trend: { name: 'Trend', subtitle: 'Follow persistent direction', x: 22, y: 23 },
    momentum: { name: 'Momentum', subtitle: 'Rank relative strength', x: 78, y: 23 },
    reversion: { name: 'Mean-reversion', subtitle: 'Test a return to the mean', x: 22, y: 77 },
    defensive: { name: 'Defensive', subtitle: 'Control downside exposure', x: 78, y: 77 },
    finalist: { name: 'Variant shortlist', subtitle: 'Compare, never auto-deploy', x: 50, y: 50 },
  };
  const chapters = [
    { at: 0, name: 'Exploration', title: 'Eight agents. Four independent starting points.', text: 'Each specialist explores a different hypothesis concurrently. Rings show scripted task progress; curves and metrics are simulated.' },
    { at: 10, name: 'Discoveries', title: 'A promising result is useful only if others can use it.', text: 'A3 discovers a risk-gated momentum candidate. Its lower illustrative drawdown becomes an idea to share, not a claim of real performance.' },
    { at: 18, name: 'Messages', title: 'Watch knowledge travel between specialists.', text: 'Packets carry specific findings. A recipient keeps its current test until delivery; inspect A5 to see the inbox arrive before the pivot.' },
    { at: 26, name: 'Pivots', title: 'A message changes the search, not just the activity log.', text: 'A5 leaves mean-reversion for risk-gated momentum. A6 adds A1’s trend filter; A8 combines defensive sizing with A3’s idea. Their tasks and progress restart.' },
    { at: 34, name: 'Variants', title: 'Shared discoveries become competing branches.', text: 'Agents create distinct children of shared candidates: tighter risk gates, faster entries, and volatility sizing. Parent links preserve why each branch exists.' },
    { at: 48, name: 'Comparison', title: 'A shortlist with trade-offs, not a guaranteed winner.', text: 'Agents gather around the leading illustrative variant. The weighted score favors M2, but M3 has higher CAGR and D2 lower drawdown. Future intent: audited evidence and human review.' },
  ];
  const seeds = [
    ['A1', 'Trend architect', 'trend', 'T0', 'EMA crossover · 20/80', 13, 24],
    ['A2', 'Regime scout', 'trend', 'T0', 'Trend persistence · 60d', 31, 24],
    ['A3', 'Momentum scout', 'momentum', 'M0', 'Relative strength · 90d', 69, 24],
    ['A4', 'Breakout critic', 'momentum', 'M0', 'Breakout confirmation · 20d', 87, 24],
    ['A5', 'Reversion explorer', 'reversion', 'R0', 'RSI rebound · 30 threshold', 13, 78],
    ['A6', 'Variant builder', 'reversion', 'R0', 'Z-score entry · −2σ', 31, 78],
    ['A7', 'Risk sentinel', 'defensive', 'D0', 'Cash gate · risk budget', 69, 78],
    ['A8', 'Allocation designer', 'defensive', 'D0', 'Volatility sizing · 12%', 87, 78],
  ];
  // Metrics are authored percentage-point examples, not calculated from these schematic curves.
  const candidates = [
    { id: 'T0', name: 'EMA baseline', family: 'trend', parent: null, cagr: 14.2, mdd: 20.8, at: 0 },
    { id: 'M0', name: 'Momentum baseline', family: 'momentum', parent: null, cagr: 18.6, mdd: 26.4, at: 0 },
    { id: 'R0', name: 'Rebound baseline', family: 'reversion', parent: null, cagr: 10.4, mdd: 17.2, at: 0 },
    { id: 'D0', name: 'Risk-budget baseline', family: 'defensive', parent: null, cagr: 7.8, mdd: 8.6, at: 0 },
    { id: 'T1', name: 'Trend + regime gate', family: 'trend', parent: 'T0', cagr: 16.0, mdd: 18.0, at: 10 },
    { id: 'M1', name: 'Risk-gated momentum', family: 'momentum', parent: 'M0', cagr: 16.8, mdd: 12.4, at: 12 },
    { id: 'R1', name: 'Rebound + cooldown', family: 'reversion', parent: 'R0', cagr: 11.6, mdd: 16.0, at: 14 },
    { id: 'D1', name: 'Adaptive risk budget', family: 'defensive', parent: 'D0', cagr: 8.2, mdd: 7.4, at: 16 },
    { id: 'M2', name: 'Momentum + tighter gate', family: 'momentum', parent: 'M1', cagr: 17.4, mdd: 10.8, at: 34 },
    { id: 'T2', name: 'Trend + volatility sizing', family: 'trend', parent: 'T1', cagr: 15.2, mdd: 9.2, at: 37 },
    { id: 'M3', name: 'Momentum + faster entry', family: 'momentum', parent: 'M1', cagr: 18.3, mdd: 14.6, at: 40 },
    { id: 'D2', name: 'Momentum + risk budget', family: 'defensive', parent: 'M1', cagr: 11.8, mdd: 6.8, at: 43 },
  ];
  const messages = [
    { id: 'p1', from: 'A3', to: 'A5', at: 18, receivedAt: 23, candidate: 'M1', label: 'lower MDD candidate', detail: 'M1 reduces illustrative MDD from 26.4% to 12.4%. Try a tighter risk gate.' },
    { id: 'p2', from: 'A1', to: 'A6', at: 20, receivedAt: 25, candidate: 'T1', label: 'regime gate discovered', detail: 'T1 adds a regime gate. Branch into volatility sizing rather than repeating the rebound test.' },
    { id: 'p3', from: 'A3', to: 'A8', at: 22, receivedAt: 27, candidate: 'M1', label: 'combine with risk budget', detail: 'Reuse M1’s momentum signal with your defensive risk budget; trade return for lower drawdown.' },
    { id: 'p4', from: 'A5', to: 'A3', at: 35, receivedAt: 39, candidate: 'M2', label: 'tighter gate variant ready', detail: 'M2 has 17.4% CAGR / 10.8% MDD in the authored example. Compare a faster-entry sibling, not a duplicate.' },
  ];
  const events = [
    { at: 0, type: 'explore', text: 'Eight specialists start four strategy families in parallel.' },
    { at: 10, type: 'discover', agent: 'A1', candidate: 'T1', task: 'Regime gate · trend confirmation', text: 'A1 discovers T1: a regime gate for trend entries.' },
    { at: 12, type: 'discover', agent: 'A3', candidate: 'M1', task: 'Risk gate · momentum confirmation', text: 'A3 discovers M1: lower illustrative MDD, with a return trade-off.' },
    { at: 14, type: 'discover', agent: 'A5', candidate: 'R1', task: 'Rebound cooldown · 5 sessions', text: 'A5 finishes a local rebound branch before hearing from A3.' },
    { at: 16, type: 'discover', agent: 'A7', candidate: 'D1', task: 'Adaptive budget · downside review', text: 'A7 discovers D1: a lower-return, lower-drawdown alternative.' },
    ...messages.flatMap(m => [
      { at: m.at, type: 'send', agent: m.from, message: m.id, text: `${m.from} → ${m.to}: ${m.label}` },
      { at: m.receivedAt, type: 'receive', agent: m.to, message: m.id, text: `${m.to} receives ${m.candidate} from ${m.from}; existing task is retained until pivot.` },
    ]),
    { at: 26, type: 'pivot', agent: 'A5', message: 'p1', family: 'momentum', candidate: 'M1', task: 'Tighter risk gate · 10% budget', position: [51, 24], text: 'A5 leaves mean-reversion → momentum because A3 delivered M1.' },
    { at: 28, type: 'pivot', agent: 'A6', message: 'p2', family: 'trend', candidate: 'T1', task: 'Trend filter + volatility sizing', position: [36, 44], text: 'A6 leaves mean-reversion → trend after A1’s regime-gate message.' },
    { at: 30, type: 'pivot', agent: 'A8', message: 'p3', family: 'momentum', candidate: 'M1', task: 'Momentum signal + defensive budget', position: [87, 46], text: 'A8 moves defensive → momentum to build a lower-risk cross-family branch.' },
    { at: 34, type: 'variant', agent: 'A5', candidate: 'M2', task: 'Compare M2 against parent M1', text: 'A5 creates M2 from M1: tighter gate, different metrics.' },
    { at: 37, type: 'variant', agent: 'A6', candidate: 'T2', task: 'Compare T2 against parent T1', text: 'A6 creates T2 from T1: volatility sizing reduces drawdown and return.' },
    { at: 39.5, type: 'pivot', agent: 'A3', message: 'p4', family: 'momentum', candidate: 'M1', task: 'Faster-entry sibling · compare to M2', position: [69, 24], text: 'A3 receives A5’s M2 finding and pivots to a faster-entry sibling of M1.' },
    { at: 40, type: 'variant', agent: 'A3', candidate: 'M3', task: 'Compare M3: more return, more risk', text: 'A3 creates sibling M3: higher CAGR than M2, but higher MDD.' },
    { at: 43, type: 'variant', agent: 'A8', candidate: 'D2', position: [87, 78], task: 'Compare D2: conservative risk budget', text: 'A8 creates D2 from M1 and returns to defensive sizing: the most defensive child, not the top score.' },
    { at: 48, type: 'compare', text: 'Illustrative score ranks M2 first. M3 has higher CAGR; D2 has lower MDD.' },
    { at: 49, type: 'converge', agent: 'A5', position: [42, 42], task: 'M2 · leading illustrative score', text: 'A5 brings M2 to the shortlist for human review.' },
    { at: 51, type: 'converge', agent: 'A3', position: [60, 42], task: 'M3 · challenge the return trade-off', text: 'A3 brings M3 as a higher-return alternative.' },
    { at: 53, type: 'converge', agent: 'A6', position: [42, 60], task: 'T2 · challenge family concentration', text: 'A6 brings T2 as the trend-family alternative.' },
    { at: 55, type: 'converge', agent: 'A8', position: [60, 60], task: 'D2 · challenge downside exposure', text: 'A8 brings D2 as the lower-drawdown alternative.' },
    { at: 60, type: 'complete', text: 'Concept complete. No strategy is deployed. Real evidence, robustness checks and human approval would be required.' },
  ].sort((a, b) => a.at - b.at);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
  const score = c => Math.round((0.6 * c.cagr - 0.4 * c.mdd) * 100) / 100;
  const candidateById = id => candidates.find(c => c.id === id);
  // Authored rule cards and sample signals, NOT rules evaluated against market data.
  // Seed specialists sharing a baseline candidate still test distinct hypotheses.
  const rule = (buy, sell, sample, signal, risk = '100% long or cash; no shorting') => ({ buy, sell, sample, signal, risk });
  const rules = {
    A1: rule('EMA20 crosses above EMA80', 'EMA20 crosses below EMA80', 'EMA20 crosses from below to above EMA80.', 'Buy'),
    A2: rule('Close > SMA60', 'Close < SMA60', 'Close 105 > SMA60 100.', 'Buy'),
    A3: rule('90-day return > 0%', '90-day return ≤ 0%', '90-day return is +8%.', 'Buy'),
    A4: rule('Close > prior 20-day high', 'Close < prior 20-day low', 'Close 105 > prior 20-day high 103.', 'Buy'),
    A5: rule('RSI14 crosses above 30', 'RSI14 ≥ 70', 'RSI14 rises from 28 to 32.', 'Buy'),
    A6: rule('20-day Z-score < −2', '20-day Z-score ≥ 0', 'Z-score is −2.3: below the mean.', 'Buy'),
    A7: rule('Close > SMA60', 'Close ≤ SMA60', 'Close 98 ≤ SMA60 100: exit to cash.', 'Sell', '50% long; keep 50% cash'),
    A8: rule('20-day volatility < 12%', '20-day volatility ≥ 12%', 'Annualized volatility is 15%: exit to cash.', 'Sell', '50% long; volatility annualized with √252'),
    T1: rule('EMA20 > EMA80 & Close > SMA60', 'EMA20 < EMA80 or Close < SMA60', 'EMA20 102 > EMA80 100; Close 105 > SMA60 101.', 'Buy'),
    M1: rule('Return90 > 0% & Close > SMA60', 'Return90 ≤ 0% or Close ≤ SMA60', 'Return90 +8%, but Close 98 ≤ SMA60 100.', 'Sell'),
    R1: rule('RSI14 crosses above 30', '3 rising closes in a row', 'Three consecutive close-to-close gains: sell the full position.', 'Sell', 'Wait 5 sessions after exit before buying again'),
    D1: rule('Close > SMA60', 'Close ≤ SMA60', 'Close equals SMA60: exit to cash.', 'Sell', '25% long when volatility ≥ 12%; otherwise 50%'),
    M2: rule('Return90 > 0% & Close > SMA60 × 1.02', 'Return90 ≤ 0% or Close ≤ SMA60', 'Close 101 is below the 102 entry gate but above the 100 exit gate.', 'Hold'),
    T2: rule('EMA20 > EMA80 & Close > SMA60', 'EMA20 < EMA80 or Close < SMA60', 'Trend and price filters pass: use half-sized exposure.', 'Buy', '50% long; keep 50% cash'),
    M3: rule('Return20 > 0% & Close > SMA20', 'Return20 ≤ 0% or Close ≤ SMA20', 'Return20 +3%; Close 105 > SMA20 103.', 'Buy'),
    D2: rule('Return90 > 0% & Close > SMA60', 'Return90 ≤ 0% or Close ≤ SMA60', 'Both entry filters pass: buy with 25% of capital.', 'Buy', '25% long; keep 75% cash'),
  };
  function testedRule(agent) {
    const pivot = [...agent.history].reverse().find(e => e.type === 'pivot');
    const variant = { A5: 'M2', A6: 'T2', A8: 'D2', A3: 'M3' }[agent.id];
    const key = pivot && agent.candidate === pivot.candidate ? variant : rules[agent.candidate] ? agent.candidate : agent.id;
    return { ...rules[key], key };
  }
  function positionAt(agent, time, reducedMotion) {
    const p = reducedMotion ? 1 : clamp((time - agent.movedAt) / 2.8, 0, 1);
    const ease = p * p * (3 - 2 * p);
    return { x: agent.origin.x + (agent.target.x - agent.origin.x) * ease,
      y: agent.origin.y + (agent.target.y - agent.origin.y) * ease };
  }
  function stateAt(value, { reducedMotion = false } = {}) {
    const time = clamp(value, 0, DURATION);
    const agents = seeds.map(([id, role, family, candidate, task, x, y]) => ({
      id, role, family, candidate, task, taskAt: 0, movedAt: 0, origin: { x, y }, target: { x, y },
      reason: 'Independent starting hypothesis; no messages received yet.', inbox: [],
      history: [{ at: 0, type: 'explore', text: `Exploring ${families[family].name}: ${task}` }],
    }));
    const applied = events.filter(e => e.at <= time);
    for (const e of applied) {
      const agent = agents.find(a => a.id === e.agent);
      if (!agent) continue;
      agent.history.push(e);
      if (e.type === 'receive') agent.inbox.push(messages.find(m => m.id === e.message));
      if (e.type === 'pivot') {
        const message = agent.inbox.find(m => m.id === e.message);
        if (!message) throw new Error(`Pivot without received message: ${e.message}`);
        agent.family = e.family;
        agent.reason = `${message.from} → ${agent.id} delivered ${message.candidate} at ${message.receivedAt}s. ${message.detail}`;
      }
      if (e.candidate) agent.candidate = e.candidate;
      if (e.type === 'variant') agent.family = candidateById(e.candidate).family;
      if (e.task) { agent.task = e.task; agent.taskAt = e.at; }
      if (e.position) {
        agent.origin = positionAt(agent, e.at, false);
        agent.target = { x: e.position[0], y: e.position[1] };
        agent.movedAt = e.at;
      }
      if (e.type === 'converge') agent.shortlisted = true;
    }
    for (const agent of agents) {
      agent.position = positionAt(agent, time, reducedMotion);
      const nextTask = events.find(e => e.at > agent.taskAt && e.agent === agent.id && e.task);
      const taskEnd = nextTask?.at ?? Math.min(DURATION, agent.taskAt + 9);
      agent.progress = clamp((time - agent.taskAt) / Math.max(0.5, taskEnd - agent.taskAt), 0, 1);
      agent.test = testedRule(agent);
    }
    const available = candidates.filter(c => c.at <= time).map(c => ({ ...c, score: score(c) }));
    return { time, reducedMotion, agents, events: applied,
      phase: chapters.filter(c => c.at <= time).at(-1),
      candidates: available, leaderboard: [...available].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
      packets: messages.filter(m => m.at <= time && time < m.receivedAt).map(m => ({ ...m,
        progress: reducedMotion ? 0.5 : (time - m.at) / (m.receivedAt - m.at) })),
      complete: time === DURATION };
  }
  // Clock has no timers itself. RAF supplies elapsed time; tests drive identical transitions.
  function createClock() {
    let time = 0, playing = false, visible = true, speed = 1;
    const snapshot = () => ({ time, playing, visible, speed });
    return {
      snapshot,
      play() { if (visible && time < DURATION) playing = true; return snapshot(); },
      pause() { playing = false; return snapshot(); },
      reset() { time = 0; playing = false; return snapshot(); },
      setVisible(value) { visible = Boolean(value); if (!visible) playing = false; return snapshot(); },
      setSpeed(value) { if ([0.5, 1, 2].includes(Number(value))) speed = Number(value); return snapshot(); },
      seek(value) { time = clamp(value, 0, DURATION); playing = false; return snapshot(); },
      next() { time = events.find(e => e.at > time)?.at ?? DURATION; playing = false; return snapshot(); },
      advance(seconds) {
        if (playing && visible) time = clamp(time + Math.max(0, Number(seconds) || 0) * speed, 0, DURATION);
        if (time === DURATION) playing = false;
        return snapshot();
      },
    };
  }
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  window.ITTSwarmScenario = freeze({ duration: DURATION, families, chapters, seeds, candidates, messages, events, stateAt, createClock, score });

  window.ITTSwarm = root => {
    if (!root || !root.ownerDocument) throw new TypeError('ITTSwarm requires a root element.');
    if (root.__ittSwarm) return root.__ittSwarm;
    const doc = root.ownerDocument, host = doc.defaultView;
    const media = host.matchMedia('(prefers-reduced-motion: reduce)');
    const clock = createClock();
    let selected = 'A5', follow = true, historyOpen = false, frame = null, previous = null, revision = '', requestedVisible = true, destroyed = false;
    const el = (tag, className, text) => {
      const item = doc.createElement(tag);
      if (className) item.className = className;
      if (text !== undefined) item.textContent = text;
      return item;
    };
    const svg = (tag, attrs = {}) => {
      const item = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value);
      return item;
    };
    const button = (text, id, handler) => {
      const item = el('button', 'sw-button', text); item.type = 'button';
      if (id) item.id = id;
      item.addEventListener('click', handler); return item;
    };
    const sectionHeading = (title, subtitle) => {
      const wrap = el('div', 'sw-section-heading');
      wrap.append(el('h3', '', title), el('span', 'sw-muted', subtitle)); return wrap;
    };
    const spark = (id, width = 92, height = 22) => {
      const c = candidateById(id), line = svg('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-label': `${id} schematic simulated equity curve`, role: 'img' });
      line.classList.add('sw-spark');
      const steps = [0, 0.16, 0.11, 0.35, 0.2, 0.46, 0.31, 0.66, 0.53, 0.82, 0.7, 1];
      const points = steps.map((v, i) => {
        const dip = i === 4 || i === 8 ? c.mdd / 65 : 0;
        const value = clamp(0.15 + v * c.cagr / 26 - dip, 0.04, 0.95);
        return `${(i * width / 11).toFixed(1)},${(height * (1 - value)).toFixed(1)}`;
      }).join(' ');
      line.append(svg('polyline', { points })); return line;
    };
    root.classList.add('itt-swarm');
    const header = el('header', 'sw-header');
    const intro = el('div');
    const eyebrow = el('div', 'sw-eyebrow', 'FUTURE RESEARCH LAB');
    const title = el('h2', 'sw-title', 'Quant Swarm '); title.append(el('span', 'sw-beta', 'BETA'));
    intro.append(eyebrow, title, el('p', 'sw-intent', 'Explore in parallel. Share discoveries. Change direction together.'));
    const truth = el('div', 'sw-truth');
    truth.append(el('strong', '', 'Concept simulation'), el('span', '', 'Scripted agents · invented metrics · no model or backtest calls'));
    header.append(intro, truth);
    const narrative = el('section', 'sw-narrative');
    const phaseNumber = el('span', 'sw-phase-number'), narrativeCopy = el('div');
    const phaseTitle = el('h3'), phaseText = el('p');
    narrativeCopy.append(phaseTitle, phaseText); narrative.append(phaseNumber, narrativeCopy);
    const controls = el('div', 'sw-controls');
    const play = button('Play scene', 'swarm-start', () => { syncVisibility(); clock.play(); previous = null; render(); schedule(); });
    const pause = button('Pause', 'swarm-pause', () => { clock.pause(); stop(); render(); });
    const reset = button('Replay', 'swarm-reset', () => api.reset());
    const next = button('Next event →', 'swarm-next', () => { clock.next(); stop(); render(); });
    const speedLabel = el('label', 'sw-speed', 'Speed '), speed = el('select'); speed.id = 'swarm-speed';
    for (const value of [0.5, 1, 2]) {
      const option = el('option', '', `${value}×`); option.value = value; speed.append(option);
    }
    speed.value = '1'; speed.addEventListener('change', () => { clock.setSpeed(speed.value); previous = null; });
    speedLabel.append(speed);
    const timer = el('output', 'sw-time'), motionNote = el('span', 'sw-motion-note');
    controls.append(play, pause, reset, next, speedLabel, timer, motionNote);
    header.append(controls);
    const timelineWrap = el('div', 'sw-timeline-wrap');
    const timelineLabel = el('label', 'sw-sr-only', 'Scene time in seconds'); timelineLabel.htmlFor = 'swarm-timeline';
    const timeline = el('input', 'sw-timeline'); timeline.id = 'swarm-timeline'; timeline.type = 'range';
    timeline.min = '0'; timeline.max = String(DURATION); timeline.step = '0.1'; timeline.value = '0';
    timeline.addEventListener('input', () => { clock.seek(timeline.value); stop(); render(); });
    const chapterNav = el('nav', 'sw-chapters'); chapterNav.setAttribute('aria-label', 'Simulation chapters');
    const chapterButtons = chapters.map((chapter, i) => {
      const b = button(`${String(i + 1).padStart(2, '0')} ${chapter.name}`, null, () => { clock.seek(chapter.at); stop(); render(); });
      b.dataset.swarmChapter = chapter.at; chapterNav.append(b); return b;
    });
    timelineWrap.append(timelineLabel, timeline, chapterNav);
    const workspace = el('div', 'sw-workspace'), arenaPanel = el('section', 'sw-arena-panel');
    arenaPanel.append(sectionHeading('Demo asset: SPY · S&P 500 ETF', 'All 8 agents · no price data loaded'));
    const arenaScroll = el('div', 'sw-arena-scroll'), arena = el('div', 'sw-arena'); arena.id = 'swarm-arena';
    arena.setAttribute('aria-label', 'Agent search arena. Select an agent to inspect its task and message history.');
    const islands = {};
    for (const [key, family] of Object.entries(families)) {
      const island = el('div', `sw-island sw-family-${key}`); island.dataset.family = key;
      island.style.left = `${family.x}%`; island.style.top = `${family.y}%`;
      const label = el('div', 'sw-island-label');
      label.append(el('strong', '', family.name), el('small', '', family.subtitle)); island.append(label);
      arena.append(island); islands[key] = island;
    }
    const hubText = el('div', 'sw-hub-text', 'Shared findings');
    hubText.append(el('small', '', 'Messages reshape the search')); arena.append(hubText);
    const paths = svg('svg', { viewBox: '0 0 1000 660', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    paths.classList.add('sw-message-paths'); arena.append(paths);
    const agentLayer = el('div', 'sw-agent-layer'); agentLayer.id = 'swarm-agents';
    const tokens = new Map();
    for (const [id, role] of seeds) {
      const token = button('', null, () => { selected = id; follow = false; revision = ''; render(); });
      token.className = 'sw-agent'; token.dataset.agent = id;
      const head = el('span', 'sw-agent-head'), ring = svg('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true' });
      ring.classList.add('sw-ring');
      ring.append(svg('circle', { cx: 22, cy: 22, r: 19, class: 'sw-ring-track' }));
      const progress = svg('circle', { cx: 22, cy: 22, r: 19, class: 'sw-ring-value', pathLength: 100 }); ring.append(progress);
      const badge = el('span', 'sw-agent-badge');
      const avatar = el('img', 'sw-agent-avatar');
      avatar.src = `/avatars/agent-${id.slice(1)}.svg`; avatar.alt = ''; avatar.width = 40; avatar.height = 40;
      avatar.draggable = false;
      badge.append(avatar, el('span', 'sw-agent-id', id), ring);
      const status = el('span', 'sw-agent-status'); head.append(badge, status);
      const roleEl = el('strong', 'sw-agent-role', role), task = el('span', 'sw-agent-task');
      const buy = el('span', 'sw-agent-rule sw-buy'), sell = el('span', 'sw-agent-rule sw-sell');
      const signal = el('span', 'sw-agent-signal');
      token.append(head, roleEl, task, buy, sell, signal); agentLayer.append(token);
      tokens.set(id, { token, progress, status, task, buy, sell, signal });
    }
    arena.append(agentLayer);
    const packetLayer = el('div', 'sw-packet-layer'); arena.append(packetLayer);
    const packetNodes = new Map();
    for (const m of messages) {
      const path = svg('path', { class: 'sw-message-path' }); paths.append(path);
      const packet = el('div', 'sw-packet', `${m.from} → ${m.to}: ${m.label}`); packet.dataset.packet = m.id;
      packet.hidden = true; packetLayer.append(packet); packetNodes.set(m.id, { path, packet });
    }
    arenaScroll.append(arena); arenaPanel.append(arenaScroll);
    const legend = el('div', 'sw-legend');
    for (const text of ['◉ Ring = task progress', '→ Packet = shared finding', '↗ Curves = simulated equity', '◎ Center = variant shortlist']) legend.append(el('span', '', text));
    arenaPanel.append(legend);
    const inspector = el('aside', 'sw-inspector'); inspector.id = 'swarm-inspector';
    inspector.setAttribute('aria-label', 'Selected agent inspector');
    const inspectorPanel = el('section', 'sw-inspector-panel');
    const inspectorToolbar = el('div', 'sw-inspector-toolbar');
    const followButton = button('Follow activity', 'swarm-follow', () => { follow = !follow; revision = ''; render(); });
    followButton.setAttribute('aria-pressed', 'true');
    inspectorToolbar.append(el('h3', '', 'Agent inspector'), followButton);
    inspectorPanel.append(inspectorToolbar, inspector);
    const messagePanel = el('section', 'sw-messages'); messagePanel.id = 'swarm-messages';
    messagePanel.append(sectionHeading('Recent messages', 'Sent → received → pivot'));
    const messageList = el('ol', 'sw-message-list'); messagePanel.append(messageList);
    const sidebar = el('div', 'sw-sidebar'); sidebar.append(inspectorPanel, messagePanel);
    workspace.append(arenaPanel, sidebar);
    const bottom = el('div', 'sw-bottom');
    const comparison = el('section', 'sw-comparison');
    comparison.append(sectionHeading('Candidate comparison', 'Illustrative metrics only'));
    comparison.append(el('p', 'sw-score-note', 'Score = 0.6 × CAGR − 0.4 × |MDD| · arbitrary weights, not a guarantee.'));
    const leaderSummary = el('p', 'sw-leader-summary'); comparison.append(leaderSummary);
    const tableScroll = el('div', 'sw-table-scroll'), table = el('table', 'sw-table');
    table.id = 'swarm-leaderboard';
    const caption = el('caption', 'sw-sr-only', 'Simulated candidates compared with their parent. MDD is shown as a positive drawdown magnitude.');
    const thead = el('thead'), headerRow = el('tr');
    for (const label of ['Candidate / parent', 'CAGR parent → child', '|MDD| parent → child', 'Score']) {
      const th = el('th', '', label); th.scope = 'col'; headerRow.append(th);
    }
    thead.append(headerRow); const tbody = el('tbody'); table.append(caption, thead, tbody); tableScroll.append(table); comparison.append(tableScroll);
    comparison.append(el('p', 'sw-footnote', 'Top 4 by score · all branches at right. Authored metrics; schematic curves, no real validation.'));
    const lineage = el('section', 'sw-lineage'); lineage.id = 'swarm-lineage';
    lineage.append(sectionHeading('Branching lineage', 'Parent → discovery → variant'));
    const lineageTree = el('div', 'sw-lineage-tree'); lineage.append(lineageTree);
    const eventHeading = el('h3', 'sw-event-heading', 'Current cause');
    const log = el('ol', 'sw-log'); log.id = 'swarm-log';
    lineage.append(eventHeading, log); bottom.append(comparison, lineage);
    const future = el('p', 'sw-future', 'Authored concept only · no model calls, real backtests or execution. Future intent: reproducible evidence and human review, never automatic deployment.');
    const announcement = el('div', 'sw-sr-only'); announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
    root.replaceChildren(header, narrative, timelineWrap, workspace, bottom, future, announcement);

    function drawInspector(state) {
      const agent = state.agents.find(a => a.id === selected), c = candidateById(agent.candidate);
      const h = el('div', 'sw-inspector-head'); h.append(el('span', 'sw-inspector-id', agent.id), el('h3', '', agent.role));
      const family = el('p', 'sw-muted sw-target-asset', `${demoAsset} · illustrative target, not a real test`);
      const test = agent.test;
      const explain = text => text.replaceAll('SMA60', '60-day average close').replaceAll('SMA20', '20-day average close')
        .replaceAll('Return90', '90-day return').replaceAll('Return20', '20-day return').replaceAll('&', 'and');
      const task = el('div', 'sw-inspector-task');
      task.append(el('small', '', 'TESTED CONDITIONS · DEMO'),
        el('p', 'sw-buy', `Buy when ${explain(test.buy)}`), el('p', 'sw-sell', `Sell all when ${explain(test.sell)}`),
        el('p', 'sw-muted', `Hold otherwise. ${test.risk}.`));
      const example = el('div', 'sw-signal-example'); example.dataset.signal = test.signal;
      example.append(el('strong', '', `Example signal: ${test.signal}`), el('p', '', test.sample));
      const receipt = agent.history.at(-1);
      const incoming = receipt?.type === 'receive' ? messages.find(m => m.id === receipt.message) : null;
      const reason = el('div', 'sw-reason'); reason.append(el('small', '', 'WHY THIS DIRECTION'), el('p', '', incoming
        ? `${incoming.from} → ${agent.id} delivered ${incoming.candidate}. ${incoming.detail} Current test retained until pivot.` : agent.reason));
      const metrics = el('div', 'sw-inspector-metrics');
      metrics.append(el('span', '', `Illustrative CAGR ${c.cagr.toFixed(1)}%`), el('span', '', `Max loss from peak ${c.mdd.toFixed(1)}%`));
      const result = el('p', 'sw-result-meaning', test.key !== c.id
        ? `${c.id} reference only; this test has no measured result.`
        : c.parent ? `vs ${c.parent}: return ${(c.cagr - candidateById(c.parent).cagr).toFixed(1)} pp; peak loss ${(c.mdd - candidateById(c.parent).mdd).toFixed(1)} pp. Invented, not measured.`
          : 'Invented comparison values, not returns calculated from these rules.');
      const curve = spark(c.id, 240, 42);
      const inboxTitle = el('h4', '', `Inbox · ${agent.inbox.length} received`), inbox = el('ul', 'sw-inbox');
      if (!agent.inbox.length) inbox.append(el('li', 'sw-muted', 'No delivery yet. Current test is independent.'));
      for (const m of agent.inbox) {
        const item = el('li'); item.dataset.message = m.id;
        item.append(el('strong', '', `${m.receivedAt}s · ${m.from} → ${m.to}: ${m.label}`), el('p', '', m.detail)); inbox.append(item);
      }
      const historyTitle = el('h4', '', 'Task & decision history'), history = el('ol', 'sw-history');
      for (const event of agent.history.slice(-5)) {
        const item = el('li', '', `${event.at}s · ${event.text}`); item.dataset.eventType = event.type; history.append(item);
      }
      const details = el('details', 'sw-inspector-details'); details.open = historyOpen;
      details.append(el('summary', '', `Why this test · ${agent.inbox.length} messages`), reason, inboxTitle, inbox, historyTitle, history);
      details.addEventListener('toggle', () => { historyOpen = details.open; });
      inspector.replaceChildren(h, family, task, example, metrics, result, details);
    }
    function drawMessages(state) {
      const sent = messages.filter(m => m.at <= state.time).slice(-3).reverse();
      messageList.replaceChildren(...sent.map(m => {
        const pivot = events.find(e => e.type === 'pivot' && e.message === m.id);
        const status = state.time < m.receivedAt ? 'IN FLIGHT' : state.time < pivot.at ? 'RECEIVED' : 'PIVOTED';
        const item = el('li'); item.dataset.message = m.id; item.dataset.status = status.toLowerCase().replace(' ', '-');
        const label = button(`${m.from} → ${m.to} · ${m.candidate}`, null, () => { selected = m.to; follow = false; revision = ''; render(); });
        label.title = m.detail;
        item.append(label, el('span', 'sw-message-status', `${m.at}s · ${status}`));
        return item;
      }));
      if (!sent.length) messageList.append(el('li', 'sw-muted', 'Independent exploration. First shared finding leaves A3 at 18s.'));
    }
    function drawComparison(state) {
      const changed = state.leaderboard.filter(c => c.parent);
      const rows = (changed.length ? changed : state.leaderboard).slice(0, 4);
      tbody.replaceChildren(...rows.map(c => {
        const parent = candidateById(c.parent), tr = el('tr'); tr.dataset.candidate = c.id;
        if (state.time >= 48 && c.id === 'M2') tr.classList.add('sw-leading');
        const label = el('th'); label.scope = 'row';
        label.append(el('strong', '', `${parent ? `${parent.id} → ` : ''}${c.id} · ${c.name}`), el('small', '', parent ? `from ${parent.id}` : 'Starting baseline'));
        const pair = key => `${parent ? `${parent[key].toFixed(1)}% → ` : ''}${c[key].toFixed(1)}%`;
        tr.append(label, el('td', '', pair('cagr')), el('td', '', pair('mdd')), el('td', '', c.score.toFixed(2))); return tr;
      }));
      leaderSummary.textContent = state.time < 48 ? `${state.candidates.length} authored candidates available · final comparison at 48s`
        : 'M2 leads this score · M3 has higher CAGR · D2 has lower drawdown';
      const available = new Set(state.candidates.map(c => c.id));
      const nodeFor = c => {
        const item = el('li', 'sw-lineage-node'); item.dataset.candidate = c.id;
        if (state.time >= 48 && c.id === 'M2') item.classList.add('sw-leading');
        const latest = state.events.at(-1);
        if (latest?.candidate === c.id && state.time - latest.at < 3) item.classList.add('sw-new-branch');
        const label = el('span', '', c.id); label.title = `${c.id} ${c.name}`;
        label.setAttribute('aria-label', `${c.id} ${c.name}`); item.append(label);
        const children = candidates.filter(child => child.parent === c.id && available.has(child.id));
        if (children.length) { const list = el('ul'); list.append(...children.map(nodeFor)); item.append(list); }
        return item;
      };
      const tree = el('ul'); tree.append(...candidates.filter(c => !c.parent).map(nodeFor)); lineageTree.replaceChildren(tree);
    }
    function render() {
      if (destroyed) return;
      const timing = clock.snapshot(), state = stateAt(timing.time, { reducedMotion: media.matches });
      if (follow) selected = state.events.filter(e => ['receive', 'pivot', 'variant', 'converge'].includes(e.type)).at(-1)?.agent || 'A5';
      followButton.setAttribute('aria-pressed', String(follow));
      followButton.textContent = follow ? 'Following activity' : 'Follow activity';
      const key = `${state.events.length}:${selected}:${timing.playing}:${state.phase.at}:${media.matches}:${Math.floor(state.time)}`;
      root.dataset.swarmPhase = state.phase.name.toLowerCase();
      root.dataset.swarmPlaying = String(timing.playing);
      root.dataset.reducedMotion = String(media.matches);
      timer.textContent = `${state.time.toFixed(1).padStart(4, '0')} / 60s`;
      timeline.value = state.time;
      timeline.setAttribute('aria-valuetext', `${state.time.toFixed(1)} seconds, ${state.phase.name}`);
      play.disabled = timing.playing || state.complete || !timing.visible;
      pause.disabled = !timing.playing; next.disabled = state.complete;
      motionNote.textContent = media.matches ? 'Reduced motion · travel disabled; Next event supported' : 'Select any agent to inspect';
      // Presentation-only collision avoidance. The public scenario's positions,
      // event times and progress remain untouched; packets use these same centers.
      const arenaWidth = arena.clientWidth || 900, arenaHeight = arena.clientHeight || 340;
      const inset = parseFloat(host.getComputedStyle(root).getPropertyValue('--sw-agent-inset')) || 44;
      const centers = state.agents.map(a => ({ id: a.id, x: arenaWidth * a.position.x / 100,
        y: inset + (arenaHeight - 2 * inset) * (a.position.y - 24) / 54 }));
      const firstToken = tokens.values().next().value.token;
      const halfWidth = firstToken.offsetWidth / 2 + 3, halfHeight = firstToken.offsetHeight / 2 + 3;
      for (let pass = 0; pass < 32; pass++) {
        for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
          const a = centers[i], b = centers[j], dx = b.x - a.x, dy = b.y - a.y;
          const overlapX = halfWidth * 2 - Math.abs(dx), overlapY = halfHeight * 2 - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          if (overlapX < overlapY) {
            const shift = (overlapX + .1) / 2 * (dx < 0 ? -1 : 1); a.x -= shift; b.x += shift;
          } else {
            const shift = (overlapY + .1) / 2 * (dy < 0 ? -1 : 1); a.y -= shift; b.y += shift;
          }
        }
        for (const c of centers) {
          c.x = clamp(c.x, halfWidth, arenaWidth - halfWidth);
          c.y = clamp(c.y, halfHeight, arenaHeight - halfHeight);
        }
      }
      // When moving cards cannot be separated in a compact arena, use a stable
      // nearest-slot arrangement rather than overlap or shrink readable text.
      const overlaps = centers.some((a, i) => centers.slice(i + 1).some(b =>
        Math.abs(a.x - b.x) < halfWidth * 2 - 1 && Math.abs(a.y - b.y) < halfHeight * 2 - 1));
      if (overlaps) {
        const columns = Math.max(1, Math.floor(arenaWidth / (halfWidth * 2)));
        const rows = Math.ceil(centers.length / columns);
        const slots = Array.from({ length: rows * columns }, (_, i) => ({
          x: (i % columns + .5) * arenaWidth / columns, y: (Math.floor(i / columns) + .5) * arenaHeight / rows,
        }));
        for (const center of centers) {
          slots.sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));
          Object.assign(center, slots.shift());
        }
      }
      const displayPositions = new Map(centers.map(c => [c.id, { x: c.x / arenaWidth * 100, y: c.y / arenaHeight * 100 }]));
      for (const agent of state.agents) {
        const token = tokens.get(agent.id);
        const position = displayPositions.get(agent.id);
        token.token.style.left = `${position.x}%`; token.token.style.top = `${position.y}%`;
        token.progress.style.strokeDasharray = `${agent.progress * 100} 100`;
        token.token.dataset.family = agent.family;
        token.token.dataset.shortlisted = String(Boolean(agent.shortlisted));
        token.token.dataset.candidate = agent.candidate;
        token.token.setAttribute('aria-pressed', String(agent.id === selected));
        token.token.setAttribute('aria-label', `${agent.id} ${agent.role}; Buy when ${agent.test.buy}; Sell when ${agent.test.sell}; example signal ${agent.test.signal}; ${Math.round(agent.progress * 100)} percent complete`);
        if (revision !== key) {
          token.status.textContent = `Demo ${Math.round(agent.progress * 100)}%`;
          token.task.textContent = `SPY · ${agent.test.key} · ${families[agent.family].name}`;
          token.buy.textContent = `Buy: ${agent.test.buy.replaceAll('SMA60', '60-day MA').replaceAll('SMA20', '20-day MA')}`;
          token.sell.textContent = `Sell: ${agent.test.sell.replaceAll('SMA60', '60-day MA').replaceAll('SMA20', '20-day MA')}`;
          token.signal.textContent = `Demo signal: ${agent.test.signal}`;
          token.signal.dataset.signal = agent.test.signal;
          token.token.title = `${agent.id} ${agent.role} · ${agent.task}`;
        }
      }
      for (const m of messages) {
        const node = packetNodes.get(m.id), packet = state.packets.find(p => p.id === m.id);
        node.packet.hidden = !packet; node.path.style.display = packet ? '' : 'none';
        if (!packet) continue;
        // SVG and packet coordinates share the responsive token-center mapping.
        const from = displayPositions.get(packet.from), to = displayPositions.get(packet.to);
        const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 12 };
        node.path.setAttribute('d', `M ${from.x * 10} ${from.y * 6.6} Q ${mid.x * 10} ${mid.y * 6.6} ${to.x * 10} ${to.y * 6.6}`);
        const p = packet.progress, q = 1 - p;
        const x = q * q * from.x + 2 * q * p * mid.x + p * p * to.x;
        const y = q * q * from.y + 2 * q * p * mid.y + p * p * to.y;
        // Keep the complete label visible even when the arc passes near an edge.
        // Fixed available width prevents position-dependent wrapping after measurement.
        node.packet.style.width = `${Math.min(230, arenaWidth - 6)}px`;
        const halfWidth = node.packet.offsetWidth / 2 + 3;
        const halfHeight = node.packet.offsetHeight / 2 + 3;
        node.packet.style.left = `${clamp(x * arenaWidth / 100, halfWidth, arenaWidth - halfWidth)}px`;
        node.packet.style.top = `${clamp(y * arenaHeight / 100, halfHeight, arenaHeight - halfHeight)}px`;
      }
      if (revision !== key) {
        const phaseIndex = chapters.indexOf(state.phase);
        phaseNumber.textContent = `${String(phaseIndex + 1).padStart(2, '0')} / 06`;
        phaseTitle.textContent = state.phase.title; phaseText.textContent = state.phase.text;
        for (let i = 0; i < chapterButtons.length; i++) chapterButtons[i].setAttribute('aria-current', i === phaseIndex ? 'step' : 'false');
        islands.finalist.classList.toggle('sw-cluster-active', state.time >= 48);
        hubText.hidden = state.time >= 48;
        drawInspector(state); drawComparison(state); drawMessages(state);
        log.replaceChildren(...state.events.slice(-1).map(event => {
          const li = el('li'); li.append(el('time', '', `${event.at}s`), el('span', '', event.text)); return li;
        }));
        const text = state.events.at(-1)?.text;
        if (announcement.textContent !== text) announcement.textContent = text;
        revision = key;
      }
    }
    function stop() {
      if (frame !== null) host.cancelAnimationFrame(frame);
      frame = null; previous = null;
    }
    function schedule() {
      if (frame === null && clock.snapshot().playing && !destroyed) frame = host.requestAnimationFrame(tick);
    }
    function tick(timestamp) {
      frame = null;
      if (destroyed || !clock.snapshot().playing) return;
      if (previous !== null) clock.advance((timestamp - previous) / 1000);
      previous = timestamp; render(); schedule();
    }
    function syncVisibility() {
      const visible = requestedVisible && !doc.hidden && !root.closest('[hidden]');
      clock.setVisible(visible);
      if (!visible) stop();
      render();
    }
    function motionChanged() { revision = ''; render(); }
    const resizeObserver = typeof host.ResizeObserver === 'function' ? new host.ResizeObserver(() => render()) : null;
    resizeObserver?.observe(arena);
    doc.addEventListener('visibilitychange', syncVisibility);
    media.addEventListener('change', motionChanged);
    const api = {
      setVisible(value) { requestedVisible = Boolean(value); syncVisibility(); },
      reset() { clock.reset(); stop(); selected = 'A5'; follow = true; revision = ''; render(); },
      // Extra deterministic controls are useful to hosts and verification; no backend dependency.
      seek(value) { clock.seek(value); stop(); render(); },
      getState() { return { ...stateAt(clock.snapshot().time, { reducedMotion: media.matches }), playback: clock.snapshot() }; },
      destroy() {
        destroyed = true; clock.pause(); stop();
        doc.removeEventListener('visibilitychange', syncVisibility); media.removeEventListener('change', motionChanged);
        resizeObserver?.disconnect();
        root.replaceChildren(); root.classList.remove('itt-swarm'); delete root.__ittSwarm;
      },
    };
    root.__ittSwarm = api;
    syncVisibility();
    return api;
  };
})();