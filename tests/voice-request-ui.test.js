import test from 'node:test';
import assert from 'node:assert/strict';
import { initTheme, UserMessageComponent } from '@earendil-works/pi-coding-agent';
import { getCapabilities, setCapabilityOverrides, visibleWidth } from '@earendil-works/pi-tui';
import { voiceRequestMarkdown } from '../src/voice-ui.ts';
import { fixture } from './fixtures/extension.js';

const sdkTheme = await import(new URL('./modes/interactive/theme/theme.js',
  import.meta.resolve('@earendil-works/pi-coding-agent')));
initTheme('dark', false);
const theme = {
  fg(token, text) {
    assert.equal(token, 'warning');
    return `\x1b[38;2;255;255;0m${text}\x1b[39m`;
  },
  bg() { assert.fail('Voice request labels must not set a background'); },
  bold: text => `\x1b[1m${text}\x1b[22m`,
};

function terminalCells(lines) {
  let fg, bg;
  const cells = [];
  for (const line of lines) {
    assert.doesNotMatch(line.replace(/\x1b\]133;[ABC]\x07|\x1b\[[\d;]*m/gu, ''), /\x1b/u);
    for (const match of line.matchAll(/\x1b\]133;[ABC]\x07|\x1b\[([\d;]*)m|([^\x1b])/gu)) {
      if (match[1] !== undefined) {
        const codes = match[1].split(';').map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === 0) { fg = bg = undefined; }
          if (code === 39) fg = undefined;
          if (code === 49) bg = undefined;
          if ((code === 38 || code === 48) && codes[i + 1] === 2) {
            const color = codes.slice(i + 2, i + 5).join(',');
            if (code === 38) fg = color;
            else bg = color;
            i += 4;
          } else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
            const color = `index:${codes[i + 2]}`;
            if (code === 38) fg = color;
            else bg = color;
            i += 2;
          }
        }
      } else if (match[2]) cells.push({ text: match[2], fg, bg });
    }
    cells.push({ text: '\n' });
  }
  return cells;
}
const plain = lines => terminalCells(lines).map(cell => cell.text).join('');
const render = (text, width, transform = markdown => voiceRequestMarkdown(markdown, theme), restored = false) =>
  new UserMessageComponent(text, undefined, 1, [transform],
    restored ? 'historic-entry' : undefined, restored ? '2026-01-01T00:00:00Z' : undefined).render(width);

test('actual Pi user terminal render keeps a bracketed yellow label without a custom background after resize', () => {
  const source = `[Voice request generation-long:${'a'.repeat(64)}]\n你好 café 👋 **body**`;
  const component = new UserMessageComponent(source, undefined, 1,
    [markdown => voiceRequestMarkdown(markdown, theme)]);
  for (const width of [8, 12, 20, 40, 80]) {
    component.invalidate();
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const cells = terminalCells(lines);
    const label = cells.filter(cell => cell.fg === '255,255,0');
    assert.equal(label.map(cell => cell.text).join('').replaceAll(' ', ''), '[Voicerequest]');
    const userBg = terminalCells([sdkTheme.theme.bg('userMessageBg', 'x')])[0].bg;
    assert.ok(label.filter(cell => cell.text.trim()).every(cell => cell.bg === userBg),
      JSON.stringify(label));
    assert.ok(cells.filter(cell => cell.text === '你').every(cell => cell.fg !== '255,255,0'));
    const displayed = plain(lines);
    assert.doesNotMatch(displayed, /generation-long|a{64}|\x1b|\[38;|\[48;/);
    assert.match(displayed, /你/);
  }
  assert.equal(plain(render(source, 80, undefined, true)), plain(render(source, 80)));
  assert.match(source, /generation-long:/);
});

test('SDK dark/light bubbles keep bracketed warning text on the ordinary background with no ANSI bleed', () => {
  const originalTrueColor = getCapabilities().trueColor;
  try {
    for (const [name, trueColor] of ['dark', 'light'].flatMap(name =>
      [true, false].map(trueColor => [name, trueColor]))) {
      setCapabilityOverrides({ trueColor });
      initTheme(name, false);
      const current = sdkTheme.theme;
      const userBg = terminalCells([current.bg('userMessageBg', 'x')])[0].bg;
      const warning = terminalCells([current.fg('warning', 'x')])[0].fg;
      for (const ending of ['\n', '\r\n', '\r']) {
        const body = `你好 café 👋 é${ending}\x1b[0mBody`;
        const source = `[Voice request generation:request]${ending}${body}`;
        assert.ok(voiceRequestMarkdown(source, current).endsWith(body));
        const component = new UserMessageComponent(source, undefined, 1,
          [markdown => voiceRequestMarkdown(markdown, current)]);
        for (const width of [5, 6, 8, 12, 16, 20, 40, 80]) {
          component.invalidate();
          const lines = component.render(width);
          assert.ok(lines.every(line => visibleWidth(line) === width), `${name}, ${width}`);
          const label = [];
          for (const line of lines) {
            const cells = terminalCells([line]);
            if (!cells.some(cell => cell.fg === warning)) continue;
            for (const cell of cells.filter(cell => cell.text !== '\n')) {
              if (cell.fg === warning) {
                label.push(cell.text);
                assert.equal(cell.bg, userBg, `${name}, ${width}, ${JSON.stringify(cell)}`);
              } else {
                assert.equal(cell.text, ' ');
                assert.equal(cell.bg, userBg, `${name}, ${width}, label padding`);
              }
            }
          }
          assert.equal(label.join('').replaceAll(' ', ''), '[Voicerequest]');
          const ordinaryBody = new UserMessageComponent(body).render(width);
          assert.equal(plain(lines).replaceAll(/\s/gu, '').slice('[Voicerequest]'.length),
            plain(ordinaryBody).replaceAll(/\s/gu, ''), `${name}, ${width}, body matches SDK baseline`);
          assert.equal(source, `[Voice request generation:request]${ending}${body}`);
          const adjacent = new UserMessageComponent('Ordinary 你好 👋').render(width);
          const before = terminalCells(adjacent);
          const after = terminalCells([...lines, ...adjacent]).slice(-before.length);
          assert.deepEqual(after, before, `${name}, ${width}, adjacent message`);
          const blank = terminalCells([lines.at(-1)]).filter(cell => cell.text !== '\n');
          assert.ok(blank.every(cell => cell.bg === userBg), `${name}, ${width}, bottom padding`);
          assert.doesNotMatch(plain(lines), /generation:request|\r/u);
        }
      }
    }
  } finally {
    setCapabilityOverrides({ trueColor: originalTrueColor });
    initTheme('dark', false);
  }
});

test('only the exact leading voice envelope is hidden; body and ordinary messages keep normal rendering', () => {
  const body = 'Keep [Voice request not-an-envelope] and 你好 👋\n```js\nlet x = 1;\n```';
  const source = `[Voice request old-generation:old-request]\n${body}`;
  const display = voiceRequestMarkdown(source, theme);
  assert.ok(display.endsWith(body));
  assert.equal(voiceRequestMarkdown(source), `[Voice request]\n\n${body}`);
  assert.equal(voiceRequestMarkdown(display, theme), display);
  for (const text of ['Voice request abc:def', '[Voice request abc:def]',
    'Quote:\n[Voice request abc:def]\nhello', '[Voice request bad id:request]\nhello',
    '[Voice request abc:def] extra\nhello', body]) {
    assert.equal(voiceRequestMarkdown(text, theme), text);
    assert.deepEqual(render(text, 40), new UserMessageComponent(text).render(40));
  }
});

test('user-only transformer leaves unique request IDs, dedup, admission, context tokens and streaming intact', async () => {
  const f = fixture();
  await f.event('session_start');
  f.ctx.ui.theme = theme;
  await f.command('on'); f.audio({ type: 'ready' });
  const [{ transform, messageTypes }] = f.transformers;
  assert.deepEqual(messageTypes, ['user']);
  for (const id of ['first', 'second']) {
    f.audio({ type: 'addressed', id });
    f.audio({ type: 'utterance', id, text: 'Same transcript' });
    f.audio({ type: 'utterance', id, text: 'Same transcript' });
  }
  assert.equal(f.messages.length, 2);
  const [first, second] = f.messages.map(([text]) => text);
  assert.notEqual(first, second);
  assert.match(first, /^\[Voice request [\w-]+:[\w-]+\]\nSame transcript$/);
  assert.deepEqual(f.messages[0][1], { expandPromptTemplates: false });
  assert.equal(f.messages[1][1].deliverAs, 'steer');
  assert.equal(transform(first), transform(second));
  const context = await f.event('context', { messages: [{ role: 'user', content: second }] });
  assert.equal(context.messages[0].content, second);
  assert.match(context.messages.at(-1).content, new RegExp(f.controller.state().generation));
  const before = f.controller.state();
  render(second, 20, transform, true);
  assert.deepEqual(f.controller.state(), before);
  assert.equal(f.messages[0][0], first);
  assert.equal(f.messages[1][0], second);
  f.ctx.ui.theme = { ...theme,
    fg: (_token, text) => `\x1b[38;2;240;220;20m${text}\x1b[39m`,
    bg: (_token, text) => `\x1b[48;2;70;20;90m${text}\x1b[49m`,
  };
  const recolored = terminalCells(render(second, 20, transform));
  const userBg = terminalCells([sdkTheme.theme.bg('userMessageBg', 'x')])[0].bg;
  assert.ok(recolored.some(cell => cell.text === 'V' && cell.fg === '240,220,20' && cell.bg === userBg));
  assert.ok(!recolored.some(cell => cell.bg === '70,20,90'));
  assert.ok(!recolored.some(cell => cell.fg === '255,255,0'));
  await f.command('off');
});
