import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { kit } from './helpers/dependencies.js';
import { startProbe } from '../../ui/probe.js';

test('library cell widths for Hangul, Japanese and ASCII', () => {
  assert.equal(kit.stringWidth('한국어'), 6);
  assert.equal(kit.stringWidth('日本語'), 6);
  assert.equal(kit.stringWidth('English'), 7);
  assert.equal(kit.truncateString('한국어日本語', 8), '한국어日');
});

test('probe handlers only: not a Windows physical mouse/IME evaluation', () => {
  const term = new EventEmitter();
  const output = [];
  const write = (...args) => { output.push(args); };
  Object.assign(term, {
    width: 100, height: 30, clear: write, moveTo: Object.assign(write, { cyan: write, yellow: write }),
    bgBlue: { white: write }, white: write, styleReset: write, fullscreen: write,
    grabInput: write, processExit: write,
  });
  const state = startProbe(term);
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 3, y: 7 });
  assert.equal(state.selected, 1);
  assert.equal(state.clicks, 1);
  term.emit('mouse', 'MOUSE_WHEEL_DOWN', {});
  assert.equal(state.scroll, 1);
  term.emit('key', 'DOWN');
  assert.equal(state.selected, 2);
  term.emit('key', '한국어日本語', [], { isCharacter: true });
  term.emit('key', 'BACKSPACE');
  assert.equal(state.text, '한국어日本');
  term.width = 60;
  term.emit('resize');
  assert.equal(state.resizes, 1);
  assert.ok(output.some(args => String(args).includes('resize to at least')));
  term.emit('key', 'CTRL_C');
});