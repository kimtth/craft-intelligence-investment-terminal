// Owned static UI is English; user input and provider responses may use any language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';

const hangul = /\p{Script=Hangul}/u;
for (const file of ['gui/index.html', 'gui/app.js', 'gui/research.js', 'gui/style.css',
  'gui/guru.js', 'gui/guru.css', 'gui/swarm.js', 'gui/swarm.css', 'desktop.js', 'copilot.js']) {
  test(`shipped static UI contains no Hangul: ${file}`, async () => {
    const source = await readFile(new URL(`../../ui/${file}`, import.meta.url), 'utf8');
    const lines = source.split(/\r?\n/);
    const offending = lines.flatMap((line, index) => hangul.test(line) ? [index + 1] : []);
    assert.deepEqual(offending, [], `${file} has Korean static source on lines ${offending.join(', ')}`);
  });
}

test('app declares English without restricting multilingual questions', async () => {
  const html = await readFile(new URL('../../ui/gui/index.html', import.meta.url), 'utf8');
  assert.match(html, /<html\b[^>]*\blang="en"/);
  assert.match(html, /Ask about this evidence, in any language/);
  // Multilingual behavior is tested with maintained shared fixtures, not optional local tools.
  const copilotTests = await readFile(new URL('./copilot.test.js', import.meta.url), 'utf8');
  assert.match(copilotTests, hangul);
});

test('README, project skill and every docs page remain English; only the personal requirements document is exempt', async () => {
  for (const relative of ['../../README.md', '../../.github/skills/itt-research/SKILL.md']) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, hangul, relative);
  }
  const docs = new URL('../../docs/', import.meta.url);
  const entries = await readdir(docs, { recursive: true });
  const pages = entries.filter(entry => entry.endsWith('.md'));
  assert.ok(pages.length >= 5, 'User, developer, architecture and historical guides remain present');
  for (const entry of pages) {
    const page = new URL(entry.replaceAll('\\', '/'), docs);
    const source = await readFile(page, 'utf8');
    assert.doesNotMatch(source, hangul, `docs/${entry}`);
    for (const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const url = new URL(target, page);
      url.hash = '';
      await assert.doesNotReject(access(url), `docs/${entry}: broken local link ${target}`);
    }
  }
});