import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../ui/gui/swarm.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const scenario = context.window.ITTSwarmScenario;
const plain = value => JSON.parse(JSON.stringify(value));
const agent = (time, id, options) => scenario.stateAt(time, options).agents.find(a => a.id === id);

test('classic script exposes factory and frozen deterministic scenario without a DOM or SDK', () => {
  assert.equal(typeof context.window.ITTSwarm, 'function');
  assert.equal(scenario.duration, 60);
  assert.equal(Object.isFrozen(scenario.events), true);
  assert.deepEqual(plain(scenario.stateAt(43)), plain(scenario.stateAt(43)));
  assert.equal(scenario.stateAt(0).agents.length, 8);
  assert.equal(new Set(scenario.stateAt(0).agents.map(a => a.family)).size, 4);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|Math\.random|Date\.now|setInterval/);
});

test('all recipient pivots require an earlier emitted and received message', () => {
  const pivots = scenario.events.filter(e => e.type === 'pivot');
  assert.equal(pivots.length, 4);
  for (const pivot of pivots) {
    const message = scenario.messages.find(m => m.id === pivot.message);
    assert.ok(message.at < message.receivedAt && message.receivedAt < pivot.at);
    assert.equal(message.to, pivot.agent);
    assert.ok(scenario.events.find(e => e.type === 'send' && e.message === pivot.message));
    const beforeReceipt = agent(message.receivedAt - 0.01, pivot.agent);
    const receipt = agent(message.receivedAt, pivot.agent);
    assert.equal(beforeReceipt.inbox.some(m => m.id === message.id), false);
    assert.equal(receipt.inbox.some(m => m.id === message.id), true);
    assert.equal(receipt.task, beforeReceipt.task, 'receipt alone does not silently change a test');
    const beforePivot = agent(pivot.at - 0.01, pivot.agent), after = agent(pivot.at, pivot.agent);
    assert.notEqual(after.task, beforePivot.task);
    assert.equal(after.progress, 0);
    assert.match(after.reason, new RegExp(`${message.from} → ${message.to}`));
  }
});

test('A5 visibly changes family, candidate, task, inbox and movement after A3 discovery', () => {
  assert.equal(agent(17, 'A5').family, 'reversion');
  assert.equal(agent(17, 'A5').candidate, 'R1');
  assert.equal(agent(22, 'A5').inbox.length, 0);
  assert.equal(agent(23, 'A5').family, 'reversion');
  const after = agent(26, 'A5');
  assert.equal(after.family, 'momentum');
  assert.equal(after.candidate, 'M1');
  assert.match(after.task, /Tighter risk gate/);
  assert.notDeepEqual(plain(agent(27, 'A5').position), plain(agent(25, 'A5').position));
  assert.equal(agent(34, 'A5').candidate, 'M2');
  assert.equal(agent(60, 'A5').shortlisted, true);
});

test('packets have deterministic trajectories and disappear exactly at receipt', () => {
  const packet = scenario.stateAt(20).packets.find(p => p.id === 'p1');
  assert.equal(packet.progress, 0.4);
  assert.ok(scenario.stateAt(22.999).packets.find(p => p.id === 'p1'));
  assert.equal(scenario.stateAt(23).packets.find(p => p.id === 'p1'), undefined);
});

test('candidate branches have real differences in authored metrics; score retains trade-offs', () => {
  for (const c of scenario.candidates.filter(c => c.parent)) {
    const parent = scenario.candidates.find(p => p.id === c.parent);
    assert.ok(parent.at < c.at);
    assert.notEqual(c.cagr, parent.cagr);
    assert.notEqual(c.mdd, parent.mdd);
  }
  const final = scenario.stateAt(60);
  assert.equal(final.candidates.length, 12);
  assert.equal(final.leaderboard[0].id, 'M2');
  const byId = id => final.candidates.find(c => c.id === id);
  assert.ok(byId('M3').cagr > byId('M2').cagr);
  assert.ok(byId('D2').mdd < byId('M2').mdd);
  assert.equal(byId('M2').score, 6.12);
  assert.equal(final.agents.filter(a => a.shortlisted).length, 4);
  assert.equal(agent(46, 'A8').family, 'defensive');
  assert.equal(final.events.at(-1).type, 'complete');
});

test('timeline seeks replay from seed without future leakage or caller mutation', () => {
  const later = scenario.stateAt(60); later.agents[0].task = 'caller mutation'; later.candidates[0].cagr = 999;
  const early = scenario.stateAt(0);
  assert.equal(early.candidates.length, 4);
  assert.ok(early.agents.every(a => a.inbox.length === 0));
  assert.equal(early.agents[0].task, 'EMA crossover · 20/80');
  assert.notEqual(scenario.stateAt(60).candidates[0].cagr, 999);
  assert.deepEqual(plain(scenario.stateAt(0)), plain(scenario.stateAt(-100)));
  assert.equal(scenario.stateAt(100).time, 60);
});

test('pause, visibility, reset and next-event controls use the same clock', () => {
  const clock = scenario.createClock();
  clock.play(); clock.advance(5); assert.equal(clock.snapshot().time, 5);
  clock.pause(); clock.advance(10); assert.equal(clock.snapshot().time, 5);
  clock.play(); clock.setVisible(false); clock.advance(20);
  assert.equal(clock.snapshot().time, 5); assert.equal(clock.snapshot().playing, false);
  clock.play(); assert.equal(clock.snapshot().playing, false);
  clock.setVisible(true); assert.equal(clock.snapshot().playing, false, 'returning never silently resumes');
  clock.next(); assert.equal(clock.snapshot().time, 10);
  clock.setSpeed(2); clock.play(); clock.advance(1); assert.equal(clock.snapshot().time, 12);
  clock.reset(); assert.equal(clock.snapshot().time, 0); assert.equal(clock.snapshot().playing, false);
  clock.next(); assert.equal(clock.snapshot().time, 10);
  clock.seek(22.5); clock.next(); assert.equal(clock.snapshot().time, 23);
  clock.seek(59); clock.play(); clock.advance(3); assert.equal(clock.snapshot().time, 60);
  assert.equal(clock.snapshot().playing, false);
});

test('frame partitions produce the same scene at a fixed elapsed time', () => {
  const a = scenario.createClock(), b = scenario.createClock(); a.play(); b.play();
  a.advance(27); for (let i = 0; i < 54; i++) b.advance(0.5);
  assert.deepEqual(plain(scenario.stateAt(a.snapshot().time)), plain(scenario.stateAt(b.snapshot().time)));
});

test('reduced motion removes travel without removing causal transitions or event steps', () => {
  const moving = agent(27, 'A5'), reduced = agent(27, 'A5', { reducedMotion: true });
  assert.notDeepEqual(plain(moving.position), plain(reduced.position));
  assert.deepEqual(plain(reduced.position), plain(reduced.target));
  assert.equal(moving.family, reduced.family); assert.equal(moving.task, reduced.task);
  assert.deepEqual(plain(moving.history), plain(reduced.history));
  assert.equal(scenario.stateAt(20, { reducedMotion: true }).packets[0].progress, 0.5);
  assert.equal(scenario.stateAt(22, { reducedMotion: true }).packets[0].progress, 0.5);
  const clock = scenario.createClock();
  while (clock.snapshot().time < 26) clock.next();
  assert.equal(agent(clock.snapshot().time, 'A5', { reducedMotion: true }).family, 'momentum');
});

test('optional Chromium: real controls, causal inspector, hidden pause and responsive scene', { skip: process.env.SWARM_BROWSER !== '1' }, async t => {
  const { chromium } = await import('./helpers/dependencies.js');
  const { startGUI } = await import('../../ui/gui-server.js');
  const calls = [];
  const forbidden = method => { calls.push(method); throw new Error(`TEST forbids ${method}`); };
  const app = await startGUI({
    backend: { on() {}, async close() {}, async request(method) { calls.push(method); throw new Error('No financial fixture for Swarm'); } },
    copilot: { status: () => forbidden('copilot.status'), analyze: () => forbidden('copilot.analyze'), criteria: () => forbidden('copilot.criteria'), async close() {} },
    guru: { request: method => forbidden(method) },
  });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.route('**/*', route => new URL(route.request().url()).origin === app.origin ? route.continue() : route.abort());
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#load-state').dataset.state === 'error');
  await page.locator('#nav-swarm').click();
  await page.evaluate(() => { window.demo = document.getElementById('swarm-stage').__ittSwarm; });
  await page.waitForFunction(() => [...document.querySelectorAll('.sw-agent-avatar')].every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await page.locator('.sw-agent').count(), 8);
  assert.match(await page.locator('.sw-truth').innerText(), /Concept simulation/);
  assert.equal(await page.locator('#swarm-start').isEnabled(), true);
  await page.locator('#swarm-timeline').fill('18');
  assert.equal(await page.evaluate(() => window.demo.getState().time), 18);
  await page.locator('#swarm-reset').click();
  await page.locator('#swarm-next').click();
  assert.equal(await page.evaluate(() => window.demo.getState().time), 10);
  await page.evaluate(() => window.demo.seek(22));
  assert.equal(await page.locator('[data-packet="p1"]').isVisible(), true);
  assert.equal(await page.locator('.sw-agent[data-agent="A5"]').getAttribute('data-family'), 'reversion');
  await page.locator('#swarm-next').click();
  assert.match(await page.locator('#swarm-inspector').innerText(), /Inbox · 1 received/);
  await page.evaluate(() => window.demo.seek(26));
  assert.equal(await page.locator('.sw-agent[data-agent="A5"]').getAttribute('data-family'), 'momentum');
  assert.match(await page.locator('.sw-reason').innerText(), /A3 → A5 delivered M1/);
  await page.locator('#swarm-start').click();
  await page.waitForFunction(() => window.demo.getState().time > 26.1);
  await page.locator('#swarm-pause').click();
  const paused = await page.evaluate(() => window.demo.getState().time);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.demo.getState().time), paused);
  await page.locator('#swarm-start').click();
  await page.evaluate(() => window.demo.setVisible(false));
  assert.equal(await page.evaluate(() => window.demo.getState().playback.playing), false);
  assert.equal(await page.locator('#swarm-start').isDisabled(), true);
  await page.evaluate(() => window.demo.setVisible(true));
  assert.equal(await page.evaluate(() => window.demo.getState().playback.playing), false);
  await page.locator('#swarm-reset').click();
  assert.equal(await page.evaluate(() => window.demo.getState().time), 0);
  await page.locator('[data-swarm-chapter="48"]').click();
  assert.match(await page.locator('.sw-leader-summary').innerText(), /M2 leads this score/);
  assert.equal(await page.locator('#swarm-lineage [data-candidate="M1"] > ul > li').count(), 3);
  await page.locator('.sw-agent[data-agent="A8"]').click();
  assert.match(await page.locator('#swarm-inspector').innerText(), /Allocation designer/);
  await page.locator('#swarm-speed').selectOption('2');
  assert.equal(await page.evaluate(() => window.demo.getState().playback.speed), 2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.demo.seek(27));
  const reduced = await page.evaluate(() => window.demo.getState());
  assert.equal(reduced.reducedMotion, true);
  const a5 = reduced.agents.find(a => a.id === 'A5');
  assert.deepEqual(a5.position, a5.target);
  assert.match(await page.locator('.sw-motion-note').innerText(), /travel disabled/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.demo.seek(60));
  assert.equal(await page.locator('.sw-agent[data-shortlisted="true"]').count(), 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const desktopMetrics = await page.locator('#swarm-arena').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight, font: getComputedStyle(node).fontFamily }));
  assert.match(desktopMetrics.font, /Segoe UI/);
  t.diagnostic(`Desktop arena: ${JSON.stringify(desktopMetrics)}`);
  if (process.env.SWARM_SCREENSHOT) await page.screenshot({ path: process.env.SWARM_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 760, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'only arena/table may scroll horizontally, not the whole page');
  assert.equal(await page.locator('#swarm-next').isVisible(), true);
  const overlaps = await page.locator('.sw-agent').evaluateAll(nodes => {
    const boxes = nodes.map(node => ({ id: node.dataset.agent, box: node.getBoundingClientRect() }));
    return boxes.flatMap((a, index) => boxes.slice(index + 1).filter(b =>
      Math.min(a.box.right, b.box.right) > Math.max(a.box.left, b.box.left)
      && Math.min(a.box.bottom, b.box.bottom) > Math.max(a.box.top, b.box.top)
    ).map(b => `${a.id}/${b.id}`));
  });
  assert.deepEqual(overlaps, [], 'final shortlist tokens stay individually readable even in the narrow scrollable arena');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => new URL(url).origin === app.origin), 'only production local assets and startup market.show');
  assert.deepEqual(calls, ['market.show'], 'the simulation performs no API/model/Guru calls');
  await page.evaluate(() => window.demo.destroy());
  assert.equal(await page.locator('#swarm-stage > *').count(), 0);
});