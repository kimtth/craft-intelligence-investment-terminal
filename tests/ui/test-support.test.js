// Shared checks must remain runnable without ignored workstation-only tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { guruVerificationFixture } from './helpers/guru-fixture.js';

test('shared UI tests and runtime do not import local-only entry points', async () => {
  for (const root of [new URL('../../ui/', import.meta.url), new URL('./', import.meta.url)]) {
    const entries = await readdir(root, { recursive: true });
    for (const entry of entries) {
      const relative = entry.replaceAll('\\', '/');
      if (relative.startsWith('node_modules/') || !relative.endsWith('.js')) continue;
      const file = new URL(relative, root);
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bnew URL\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const resolved = new URL(specifier, file);
        assert.ok(!resolved.pathname.includes('/tools/local/'), `${relative}: shared dependency on local tools`);
        // Static relative module imports must survive a checkout without ignored tools.
        if (specifier.endsWith('.js')) await assert.doesNotReject(access(resolved), `${relative}: ${specifier}`);
      }
    }
  }
});

test('UI root contains product files, not relocated test or workstation scripts', async () => {
  const entries = await readdir(new URL('../../ui/', import.meta.url));
  assert.deepEqual(entries.filter(name => /\.test\.js$|^(?:verify|record|capture)|^(?:test-support|local-tools)$/.test(name)), []);
  assert.ok(entries.includes('probe.js'), 'The product probe must remain available');
});

test('offline Guru fixture remains explicit and exercises the production adapter', async () => {
  const fixture = guruVerificationFixture();
  const result = await fixture.service.request('guru.funds', {});
  assert.equal(result.data.funds[0].name, fixture.label);
  assert.equal(result.data.funds[0].returns['1y_total'], 23.8);
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.label, /TEST FIXTURE ONLY/);
});

test('README links shared guides instead of private artifacts or a status log', async () => {
  const source = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /video|\.mp4\b|\.webm\b|\bAva\b|output\//i);
  assert.doesNotMatch(source, /## Current status|TEST ONLY Guru layout report/);
  for (const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    await assert.doesNotReject(access(new URL(match[1], new URL('../../README.md', import.meta.url))));
  }
});