import kit from 'terminal-kit';
import { pathToFileURL } from 'node:url';

// Only an input/rendering probe, not the research product UI.
export function startProbe(term = kit.terminal) {
  const state = { selected: 0, scroll: 0, text: '', clicks: 0, resizes: 0 };
  const labels = ['SYN-A / 합성', 'SYN-B / 合成', 'SYN-C / Synthetic'];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const draw = () => {
    term.clear();
    if (term.width < 70 || term.height < 22) {
      term.moveTo(1, 1, 'P0 input probe: resize to at least 70 x 22. Ctrl-C exits.');
      return;
    }
    term.moveTo.cyan(2, 2, 'INTELLIGENT TRADING TERMINAL | P0 INPUT PROBE');
    term.moveTo.yellow(2, 4, 'SYNTHETIC labels only | No prices, engine, or LLM connection');
    labels.forEach((label, index) => {
      term.moveTo(2, 6 + index);
      (index === state.selected ? term.bgBlue.white : term.white)(
        `${index === state.selected ? '>' : ' '} ${label}   `,
      );
    });
    term.styleReset();
    term.moveTo(2, 10, 'Click a row / Up Down; wheel scroll; type Korean/Japanese/English.');
    term.moveTo(2, 12, `Clicks: ${state.clicks} | Scroll: ${state.scroll} | Resizes: ${state.resizes}`);
    term.moveTo(2, 14, 'Input (echo only, NOT natural-language interpretation):');
    // Keep grapheme clusters and let terminal-kit calculate full-width cell fitting.
    term.moveTo(2, 15, kit.truncateString(state.text, term.width - 4));
    term.moveTo(2, 18, 'Tokens: no recorded calls | Cost: unknown | Ctrl-C: exit');
    term.moveTo(2, 20, `Selected: ${labels[state.selected]}`);
  };
  term.fullscreen(true);
  term.grabInput({ mouse: 'button' });
  term.on('key', (name, matches, data) => {
    if (name === 'CTRL_C') {
      term.grabInput(false);
      term.fullscreen(false);
      term.styleReset();
      term.processExit(0);
      return;
    }
    if (name === 'UP') state.selected = (state.selected + 2) % 3;
    else if (name === 'DOWN') state.selected = (state.selected + 1) % 3;
    else if (name === 'BACKSPACE') {
      state.text = [...segmenter.segment(state.text)].slice(0, -1).map(x => x.segment).join('');
    } else if (data?.isCharacter) state.text += name;
    draw();
  });
  term.on('mouse', (name, data) => {
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED' && data.x >= 2 && data.x <= 30 && data.y >= 6 && data.y <= 8) {
      state.selected = data.y - 6;
      state.clicks++;
    }
    if (name === 'MOUSE_WHEEL_DOWN') state.scroll++;
    if (name === 'MOUSE_WHEEL_UP') state.scroll = Math.max(0, state.scroll - 1);
    draw();
  });
  term.on('resize', () => { state.resizes++; draw(); });
  draw();
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Interactive terminal required. P0 probe is not a headless research command.');
    process.exitCode = 2;
  } else startProbe();
}