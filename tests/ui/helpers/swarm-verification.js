// Real production startGUI assets + Chromium. No financial fixtures, SDK or Guru calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from './dependencies.js';
import { startGUI } from '../../../ui/gui-server.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const viewports = [{ width: 1366, height: 768 }, { width: 1440, height: 900 },
  { width: 1920, height: 1080 }, { width: 800, height: 1000 }];

// Executed inside the real browser. Bounding boxes and clipping ancestors, not CSS text.
function inspectScene(all = false) {
  if (all) {
    const api = document.querySelector('#swarm-stage').__ittSwarm, results = [];
    for (let i = 0; i <= 240; i++) { api.seek(i / 4); results.push(inspectScene()); }
    return results;
  }
  const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const contains = (a, b) => b.width > 0 && b.height > 0 && b.left >= a.left - 1 && b.top >= a.top - 1 && b.right <= a.right + 1 && b.bottom <= a.bottom + 1;
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const issues = [];
  const shell = rect(document.querySelector('.app-shell')), rail = rect(document.querySelector('.rail'));
  const main = rect(document.querySelector('#main')), chat = document.querySelector('#copilot-panel');
  if (!chat.hidden || getComputedStyle(chat).display !== 'none' || rect(chat).height !== 0) issues.push('Swarm: chat must be hidden and occupy no space');
  for (const [edge, expected] of Object.entries({ left: rail.right, right: shell.right, top: shell.top, bottom: shell.bottom })) {
    if (Math.abs(main[edge] - expected) > 1) issues.push(`Swarm: main has not reclaimed ${edge} bound`);
  }
  const visible = (el, name) => {
    const r = rect(el);
    if (!contains(viewport, r)) issues.push(`${name}: outside viewport ${JSON.stringify(r)}`);
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), p = rect(parent);
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (r.left < p.left - 1 || r.right > p.right + 1)) issues.push(`${name}: horizontally clipped by ${parent.id || parent.className}`);
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (r.top < p.top - 1 || r.bottom > p.bottom + 1)) issues.push(`${name}: vertically clipped by ${parent.id || parent.className}`);
    }
    return r;
  };
  const selectors = ['#main', '#swarm-stage', '#swarm-arena', '.sw-narrative', '.sw-narrative h3', '.sw-narrative p',
    '.sw-controls', '.sw-timeline-wrap', '#swarm-messages', '#swarm-inspector', '.sw-inspector-task', '.sw-signal-example', '.sw-result-meaning',
    '.sw-inspector-metrics', '.sw-inspector-details summary', '.sw-comparison', '#swarm-lineage', '.sw-future',
    '#swarm-log li', '.sw-message-list li', '#swarm-leaderboard tr', '.sw-lineage-node > span'];
  const boxes = {};
  for (const selector of selectors) for (const [i, el] of [...document.querySelectorAll(selector)].entries()) boxes[`${selector}:${i}`] = visible(el, `${selector}:${i}`);
  const arena = rect(document.querySelector('#swarm-arena'));
  const agents = [...document.querySelectorAll('.sw-agent')].map(el => ({ id: el.dataset.agent, box: visible(el, el.dataset.agent) }));
  if (agents.length !== 8) issues.push(`Expected eight agents, got ${agents.length}`);
  for (const el of document.querySelectorAll('.sw-agent-rule, .sw-agent-signal')) {
    visible(el, `${el.parentElement.dataset.agent} ${el.className}`);
    if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) issues.push(`Clipped rule: ${el.textContent}`);
  }
  for (const [i, a] of agents.entries()) {
    if (!contains(arena, a.box)) issues.push(`${a.id}: outside arena`);
    for (const b of agents.slice(i + 1)) if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > .1 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > .1) issues.push(`Agent overlap ${a.id}/${b.id}`);
  }
  const packets = [...document.querySelectorAll('.sw-packet:not([hidden])')].map(el => ({ id: el.dataset.packet, box: visible(el, `packet ${el.dataset.packet}`) }));
  for (const p of packets) if (!contains(arena, p.box)) issues.push(`Packet ${p.id}: outside arena`);
  for (const selector of ['html', 'body', '#main', '#swarm-view', '#swarm-stage', '.sw-arena-scroll', '#swarm-inspector', '.sw-table-scroll', '.sw-lineage-tree', '.sw-log', '#swarm-messages']) {
    const el = document.querySelector(selector);
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) issues.push(`${selector}: requires scroll (${el.scrollWidth}x${el.scrollHeight} > ${el.clientWidth}x${el.clientHeight})`);
  }
  return { time: document.querySelector('#swarm-stage').__ittSwarm.getState().time, issues: [...new Set(issues)], agents, packets, boxes };
}

export async function verifySwarmDemo({ artifacts = false } = {}) {
  const runs = path.join(root, 'output/swarm-demo-verification/runs');
  if (artifacts) await fs.mkdir(runs, { recursive: true });
  const output = artifacts ? await fs.mkdtemp(path.join(runs, `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-`)) : null;
  const report = { status: 'RUNNING', contract: { viewports, interval: .25, start: 0, end: 60, samplesPerViewport: 241,
    integration: 'Unmodified startGUI HTTP assets and production UI; market.show explicitly unavailable, no fabricated finance',
    scope: 'Authored demo only; not finance, native Electron, live Guru or model validation' }, checks: [], layouts: [], screenshots: [], backendCalls: [], forbiddenCalls: [], externalRequests: [], browserErrors: [], assets: [] };
  const check = async (name, action) => {
    try { const evidence = await action(); report.checks.push({ name, status: 'PASS', evidence }); }
    catch (error) { report.checks.push({ name, status: 'FAIL', error: error.message }); }
  };
  const deny = method => { report.forbiddenCalls.push(method); throw new Error(`Verification forbids ${method}`); };
  let app, browser;
  try {
    const sources = ['ui/gui-server.js', 'ui/gui/index.html', 'ui/gui/app.js', 'ui/gui/research.js', 'ui/gui/style.css', 'ui/gui/swarm.js', 'ui/gui/swarm.css', 'tests/ui/helpers/swarm-verification.js'];
    report.sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, crypto.createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
    app = await startGUI({ backend: { on() {}, async close() {}, async request(method) {
      report.backendCalls.push(method);
      if (method !== 'market.show') return deny(method);
      throw new Error('Verification intentionally provides no financial data');
    } }, copilot: { status: () => deny('copilot.status'), analyze: () => deny('copilot.analyze'), criteria: () => deny('copilot.criteria'), async close() {} },
    guru: { request: method => deny(method) } });
    await check('Eight exact local SVG routes: MIME, bytes, guards and strict 404 paths', async () => {
      const raw = (pathname, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
        const request = http.request(app.origin, { path: pathname, method, headers }, response => { const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })); });
        request.on('error', reject); request.end();
      });
      for (let i = 1; i <= 8; i++) {
        const url = `/avatars/agent-${i}.svg`, response = await raw(url), bytes = await fs.readFile(path.join(root, 'ui/gui', url));
        assert.equal(response.status, 200); assert.match(response.headers['content-type'], /^image\/svg\+xml(?:;|$)/);
        assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['cache-control'], 'no-store');
        assert.deepEqual(response.body, bytes); assert.match(bytes.toString(), /<svg\b/);
        report.assets.push({ url, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      }
      for (const url of ['/avatars/agent-0.svg', '/avatars/agent-9.svg', '/avatars/agent-01.svg', '/avatars/agent-1.svg?x=1', '/avatars/agent-1.svg/extra', '/avatars/../app.js', '/avatars/%2e%2e/app.js', '/avatars/%2e%2e%2fapp.js', '/avatars/..%5capp.js', '/avatars/%61gent-1.svg', '/avatars/agent-1.svg%00', '/avatars/AGENT-1.svg', '/avatars/C:/Windows/win.ini']) assert.equal((await raw(url)).status, 404, url);
      assert.equal((await raw('/avatars/agent-1.svg', { Host: 'evil.invalid' })).status, 403);
      assert.equal((await raw('/avatars/agent-1.svg', {}, 'POST')).status, 404);
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: viewports[0], reducedMotion: 'no-preference' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === app.origin) return route.continue();
      report.externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    const apiCalls = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api')) apiCalls.push(request.postDataJSON()?.method); });
    await page.goto(app.url);
    await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'error');
    for (const viewport of viewports) {
      const label = `${viewport.width}x${viewport.height}`;
      await page.setViewportSize(viewport); await page.reload();
      await expect(page.locator('#load-state')).toHaveAttribute('data-state', 'error');
      const draft = `UNSENT swarm verification ${label}`;
      await page.locator('#copilot-question').fill(draft);
      // Explicit DOM-only history fixture, not a generated answer or model call.
      const chatFixture = await page.evaluateHandle(() => {
        const panel = document.querySelector('#copilot-panel'), question = document.querySelector('#copilot-question');
        const history = document.querySelector('#copilot-history'), entry = document.createElement('article');
        entry.textContent = 'TEST ONLY preserved history sentinel'; history.append(entry);
        return { panel, question, history, entry, html: history.innerHTML, draft: question.value };
      });
      const retainedChat = async markets => {
        if (markets) await expect(page.locator('#copilot-panel')).toBeVisible();
        else {
          await expect(page.locator('#copilot-panel')).toBeHidden();
          const bounds = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { main: rect('#main'), shell: rect('.app-shell'), rail: rect('.rail'), chat: rect('#copilot-panel') };
          });
          assert.equal(bounds.chat.height, 0);
          for (const [edge, expected] of Object.entries({ left: bounds.rail.right, right: bounds.shell.right, top: bounds.shell.top, bottom: bounds.shell.bottom })) {
            assert.ok(Math.abs(bounds.main[edge] - expected) <= 1, `${label}: hidden workspace reclaims ${edge}`);
          }
        }
        assert.equal(await page.evaluate(f => f.panel === document.querySelector('#copilot-panel')
          && f.question === document.querySelector('#copilot-question') && f.history === document.querySelector('#copilot-history')
          && f.entry === f.history.lastElementChild && f.history.innerHTML === f.html && f.question.value === f.draft, chatFixture), true, 'Same chat nodes, history and draft retained');
        const beforeSettings = apiCalls.length;
        await page.locator('#nav-settings').click();
        await expect(page.locator('#settings-dialog')).toBeVisible();
        await expect(page.locator('#settings-dialog #copilot-check')).toBeVisible();
        await expect(page.locator('#copilot-check')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#nav-settings')).toBeFocused();
        assert.equal(apiCalls.length, beforeSettings, 'Opening Settings must not check connection');
      };
      const before = apiCalls.length;
      await page.locator('#nav-swarm').click();
      await expect(page.locator('#swarm-stage')).toBeVisible();
      await check(`${label}: local loaded avatars and purple Beta contrast`, async () => {
        await page.waitForFunction(() => [...document.querySelectorAll('.sw-agent-avatar')].length === 8 && [...document.querySelectorAll('.sw-agent-avatar')].every(i => i.complete && i.naturalWidth > 0));
        assert.deepEqual(await page.locator('.sw-agent-avatar').evaluateAll(nodes => nodes.map(i => new URL(i.currentSrc).pathname)), Array.from({ length: 8 }, (_, i) => `/avatars/agent-${i + 1}.svg`));
        const badges = await page.locator('.sw-beta, #nav-swarm .beta-badge').evaluateAll(nodes => nodes.map(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color })));
        assert.ok(badges.length > 0);
        const luminance = rgb => rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        for (const b of badges) { assert.equal(b.background, 'rgb(109, 40, 217)'); assert.equal(b.color, 'rgb(255, 255, 255)'); assert.ok(1.05 / (luminance([109, 40, 217]) + .05) >= 4.5); }
        return badges;
      });
      await check(`${label}: real play pause replay next speed timeline keyboard and inspector controls`, async () => {
        await page.locator('#swarm-reset').click();
        await page.locator('.sw-agent[data-agent="A2"]').click();
        await expect(page.locator('.sw-arena-panel .sw-section-heading h3')).toHaveText('Demo asset: SPY · S&P 500 ETF');
        await expect(page.locator('.sw-target-asset')).toContainText('SPY · S&P 500 ETF');
        for (const task of await page.locator('.sw-agent-task').allTextContents()) assert.match(task, /^SPY · /);
        await expect(page.locator('.sw-agent[data-agent="A2"] .sw-agent-rule').first()).toHaveText('Buy: Close > 60-day MA');
        await expect(page.locator('.sw-inspector-task')).toContainText('60-day average close');
        await expect(page.locator('.sw-signal-example')).toContainText('Close 105 > SMA60 100');
        await page.locator('#swarm-stage').evaluate(el => el.__ittSwarm.seek(14));
        await page.locator('.sw-agent[data-agent="A5"]').click();
        await expect(page.locator('.sw-agent[data-agent="A5"]')).toContainText('Sell: 3 rising closes in a row');
        await expect(page.locator('.sw-signal-example')).toContainText('sell the full position');
        await page.locator('#swarm-stage').evaluate(el => el.__ittSwarm.seek(26));
        await expect(page.locator('.sw-agent[data-agent="A5"]')).toContainText('60-day MA × 1.02');
        await expect(page.locator('.sw-agent[data-agent="A5"]')).toContainText('Demo signal: Hold');
        await expect(page.locator('.sw-result-meaning')).toContainText('reference only');
        await page.locator('#swarm-reset').click();
        await page.locator('#swarm-start').click();
        await expect.poll(() => page.locator('#swarm-timeline').inputValue().then(Number)).toBeGreaterThan(.1);
        await page.locator('#swarm-pause').click(); const paused = await page.locator('#swarm-timeline').inputValue();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#swarm-timeline').inputValue(), paused);
        await page.locator('#swarm-reset').click(); await page.locator('#swarm-next').click();
        await expect(page.locator('#swarm-timeline')).toHaveValue('10');
        await page.locator('#swarm-speed').selectOption('2');
        assert.equal(await page.locator('#swarm-stage').evaluate(el => el.__ittSwarm.getState().playback.speed), 2);
        await page.locator('#swarm-timeline').click();
        await page.locator('#swarm-timeline').press('Home'); await expect(page.locator('#swarm-timeline')).toHaveValue('0');
        await page.locator('#swarm-timeline').press('ArrowRight'); await expect(page.locator('#swarm-timeline')).toHaveValue('0.1');
        await page.locator('[data-swarm-chapter="18"]').click();
        await page.locator('#swarm-timeline').fill('23');
        await expect(page.locator('.sw-message-list [data-message="p1"]')).toHaveAttribute('data-status', 'received');
        await page.locator('.sw-message-list [data-message="p1"] button').click();
        await expect(page.locator('.sw-inspector-id')).toHaveText('A5');
        await page.locator('.sw-inspector-details summary').click();
        await expect(page.locator('.sw-inbox [data-message="p1"]')).toBeVisible();
        await page.locator('.sw-inspector-details summary').click();
        await page.locator('[data-swarm-chapter="26"]').click();
        await expect(page.locator('.sw-agent[data-agent="A5"]')).toHaveAttribute('data-family', 'momentum');
        await expect(page.locator('.sw-reason')).toContainText('A3 → A5');
        for (let i = 1; i <= 8; i++) { await page.locator(`.sw-agent[data-agent="A${i}"]`).click(); await expect(page.locator('.sw-inspector-id')).toHaveText(`A${i}`); }
        await page.locator('.sw-agent[data-agent="A3"]').focus(); await page.keyboard.press('Enter');
        await expect(page.locator('.sw-inspector-id')).toHaveText('A3');
        await page.locator('#swarm-follow').click(); await expect(page.locator('#swarm-follow')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('[data-swarm-chapter="48"]').click(); await expect(page.locator('.sw-leader-summary')).toContainText('M2 leads this score');
        await page.locator('#swarm-timeline').press('End'); await expect(page.locator('#swarm-timeline')).toHaveValue('60');
        await expect(page.locator('#swarm-start')).toBeDisabled();
        await expect(page.locator('.sw-agent[data-shortlisted="true"]')).toHaveCount(4);
      });
      // Public deterministic seek renders every sample, including final convergence; no private clock mutation.
      const samples = await page.evaluate(inspectScene, true);
      report.layouts.push({ viewport, samples });
      await check(`${label}: 241 samples, eight nonoverlapping agents, packets, content and panels fit without scrolling`, async () => {
        const failures = samples.filter(s => s.issues.length); assert.equal(failures.length, 0, `${failures.length}/241 failed; ${JSON.stringify(failures.slice(0, 2).map(s => ({ time: s.time, issues: s.issues })))}`);
        return { samples: samples.length, packetSamples: samples.filter(s => s.packets.length).length };
      });
      if (output) for (const time of [0, 18, 22, 26, 34, 48, 60]) {
        await page.locator('#swarm-stage').evaluate((el, value) => el.__ittSwarm.seek(value), time);
        const filename = `${label}-${String(time).padStart(2, '0')}s.png`;
        await page.screenshot({ path: path.join(output, filename), fullPage: true }); report.screenshots.push(filename);
      }
      await check(`${label}: Markets-only chat, reclaimed bounds, retained history/draft/nodes, Settings and departure pauses without API`, async () => {
        await retainedChat(false);
        assert.equal(apiCalls.length, before, 'Swarm makes zero API requests');
        await page.locator('#swarm-reset').click(); await page.locator('#swarm-start').click();
        // Guru is covered by workspace-layout's explicit offline feed fixture;
        // this verifier retains its zero-Guru-call contract.
        for (const nav of ['#nav-markets', '#nav-backtest', '#nav-research', '#research-tab-trigger']) {
          if (nav === '#research-tab-trigger') await page.locator('#nav-research').click();
          await page.locator(nav).click(); await retainedChat(nav === '#nav-markets');
          assert.equal(await page.locator('#swarm-stage').evaluate(el => el.__ittSwarm.getState().playback.playing), false);
          await page.locator('#nav-swarm').click(); await retainedChat(false);
          assert.equal(await page.locator('#swarm-stage').evaluate(el => el.__ittSwarm.getState().playback.playing), false);
        }
        assert.equal(apiCalls.length, before, 'Workspace transitions and Settings make zero API requests');
      });
      await chatFixture.dispose();
    }
    await check('No external requests, runtime errors, Guru or SDK calls', async () => {
      assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.forbiddenCalls, []);
      assert.ok(report.backendCalls.every(m => m === 'market.show')); assert.ok(apiCalls.every(m => m === 'market.show'));
      return { apiCalls };
    });
    await check('Production source remained unchanged during verification', async () => {
      for (const [file, hash] of Object.entries(report.sourceHashes)) assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex'), hash, file);
    });
  } catch (error) { report.checks.push({ name: 'Verification execution', status: 'FAIL', error: error.stack }); }
  finally {
    await browser?.close(); await app?.close();
    report.status = report.checks.some(c => c.status === 'FAIL') ? 'FAIL' : 'PASS';
    if (output) await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  return { report, output };
}
