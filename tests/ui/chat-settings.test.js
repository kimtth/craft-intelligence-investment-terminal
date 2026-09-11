import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from './helpers/dependencies.js';
import { startGUI } from '../../ui/gui-server.js';

test('chat stays compact; Settings owns connection; Markdown is safe and history retains formatting', async () => {
  const calls = [];
  let failStatus = false;
  const app = await startGUI({ copilot: {
    async status() {
      calls.push('status');
      if (failStatus) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      return { status: 'ready', authenticated: true, models: [{ id: 'test-model', name: 'Test model' }],
        identity: { login: 'test-account', host: 'github.com', authType: 'user' } };
    },
    async analyze(request) {
      calls.push('analyze');
      return { contextIdentity: request, scope: 'saved_snapshot_only', model: request.model,
        answer: '## Observations\n\n**Readable answer**\n\n- First item\n- Second item\n\n<script>globalThis.injected=true</script>\n\n[unsafe](javascript:alert(1))\n\n![image](https://invalid.example/image.png)\n\n| Asset | Value |\n| --- | --- |\n| SPY | 100 |' };
    },
    async close() {},
  } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    await page.locator('[data-testid="candle"]').first().waitFor();
    await page.reload();
    await page.locator('[data-testid="candle"]').first().waitFor();
    await expect(page.locator('#criteria-connect')).toHaveCount(0);
    await expect(page.locator('#copilot-open-settings')).toHaveCount(0);
    await expect(page.locator('#copilot-check')).toHaveCount(1);
    await expect(page.locator('#settings-dialog #copilot-check')).toHaveCount(1);
    assert.equal(await page.locator('#copilot-panel #copilot-settings').count(), 0);
    assert.equal(await page.locator('#copilot-panel #copilot-sharing').count(), 0);
    assert.equal(await page.locator('#copilot-selection-status').isVisible(), false);
    assert.equal(await page.locator('#copilot-use-selection').isVisible(), false);
    await page.locator('#copilot-question').fill('Unsent question before connection');
    await expect(page.locator('#copilot-analyze')).toBeDisabled();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('#close-settings')).toBeFocused();
    await expect(page.locator('#copilot-model')).toBeDisabled();
    await page.locator('#copilot-account > summary').click();
    assert.deepEqual(calls, []);
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-settings')).toBeFocused();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#close-settings')).toBeFocused();
    assert.deepEqual(calls, [], 'Opening Settings must not check connection or request AI');
    await page.locator('#copilot-check').click();
    await expect(page.locator('#copilot-model')).toBeEnabled();
    await page.locator('#copilot-model').selectOption('test-model');
    await page.locator('#close-settings').click();
    await expect(page.locator('#copilot-open-settings')).toHaveCount(0);
    await expect(page.locator('#nav-settings')).toBeVisible();
    await expect(page.locator('#copilot-analyze')).toBeEnabled();
    assert.deepEqual(calls, ['status']);
    for (const question of ['First question', 'Second question']) {
      await page.locator('#copilot-question').fill(question);
      await page.locator('#copilot-analyze').click();
      await page.waitForFunction(() => document.querySelector('#copilot-question').value === '');
      assert.equal(await page.locator('#copilot-answer h2').textContent(), 'Observations');
      assert.equal(await page.locator('#copilot-answer strong').textContent(), 'Readable answer');
      assert.equal(await page.locator('#copilot-answer li').count(), 2);
      assert.equal(await page.locator('#copilot-answer script, #copilot-answer img, #copilot-answer a').count(), 0);
      assert.equal(await page.locator('#copilot-answer table').count(), 1);
      assert.equal(await page.evaluate(() => globalThis.injected), undefined);
      assert.equal(await page.locator('#copilot-progress').textContent(), '');
    }
    assert.equal(await page.locator('#copilot-transcript h2').textContent(), 'Observations');
    assert.deepEqual(calls, ['status', 'analyze', 'analyze']);
    failStatus = true;
    await page.locator('#nav-settings').click();
    await expect(page.locator('#close-settings')).toBeFocused();
    assert.deepEqual(calls, ['status', 'analyze', 'analyze'], 'Reopening Settings must not request AI or status');
    await page.locator('#copilot-check').click();
    await page.locator('#settings-error').waitFor({ state: 'visible' });
    await expect(page.locator('#copilot-model')).toBeDisabled();
    assert.equal(await page.locator('#copilot-error').isVisible(), false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-settings')).toBeFocused();
    await page.locator('#copilot-question').fill('Unsent question after connection failure');
    await expect(page.locator('#copilot-analyze')).toBeDisabled();
    assert.deepEqual(calls, ['status', 'analyze', 'analyze', 'status']);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.locator('#copilot-panel').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});