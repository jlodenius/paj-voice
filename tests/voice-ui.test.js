import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceStatus, voiceWidget } from '../src/voice-ui.js';

const colors = { accent: 36, success: 32, warning: 33, error: 31, muted: 90, dim: 90 };
const theme = {
  fg: (color, text) => `\x1b[${colors[color]}m${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
  bg: (_color, text) => `\x1b[48;5;235m${text}\x1b[0m`,
};
const plain = text => text.replace(/\x1b\[[0-9;]*m/gu, '');
const active = { enabled: true };
const render = (state, width = 80) => voiceWidget(state)(null, theme).render(width);

test('voice mode has a themed panel with an explicit hot microphone badge and controls', () => {
  const lines = render(active);
  assert.equal(lines.length, 5);
  assert.match(plain(lines[0]), /VOICE MODE.*OPEN MIC/);
  assert.match(lines[0], /\x1b\[33m/);
  assert.doesNotMatch(lines.join(''), /\x1b\[(31|32|36)m/);
  assert.match(plain(lines[1]), /READY.*listening/);
  assert.match(plain(lines[2]), /recognized speech.*normal tools/);
  assert.match(plain(lines[3]), /\/paj-voice mute.*\/paj-voice off/);
  assert.match(voiceStatus(active, theme), /\x1b\[33m/);
});

test('warming, muted, working, receiving and speaking states remain distinct without color', () => {
  const cases = [
    [{ starting: true }, 'warming up', 'ready beep'],
    [{ muted: true, processing: true }, 'MIC CLOSED', 'Agent working'],
    [{ ...active, processing: true }, 'OPEN MIC', 'WORKING'],
    [{ ...active, capturing: true, processing: true }, 'OPEN MIC', 'RECEIVING SPEECH'],
    [{ ...active, speaking: true }, 'OPEN MIC', 'SPEAKING'],
  ];
  for (const [state, badge, activity] of cases) {
    const text = render(state).map(plain).join('\n');
    assert.ok(text.includes(badge), text);
    assert.ok(text.includes(activity), text);
  }
  assert.equal(voiceWidget({}), undefined);
  assert.equal(voiceStatus({}), undefined);
});

test('the panel fits narrow terminals and retains bounds after invalidation', () => {
  const widget = voiceWidget(active)(null, theme);
  for (const width of [1, 4, 8, 20, 40, 80, 120]) {
    const lines = widget.render(width).map(plain);
    assert.ok(lines.every(line => [...line].length <= width));
  }
  const before = widget.render(80);
  widget.invalidate();
  assert.deepEqual(widget.render(80), before);
});
