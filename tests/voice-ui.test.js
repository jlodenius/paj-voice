import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
const layout = { truncateToWidth, visibleWidth, wrapTextWithAnsi };
import { voiceStatus, voiceWidget } from '../src/voice-ui.ts';

const colors = { accent: 36, success: 32, warning: 33, error: 31, muted: 90, dim: 90 };
const theme = {
  fg: (color, text) => `\x1b[${colors[color]}m${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
  bg: (_color, text) => `\x1b[48;5;235m${text}\x1b[0m`,
};
const plain = text => text.replace(/\x1b\[[0-9;]*m/gu, '');
const active = { enabled: true };
const render = (state, width = 80) => voiceWidget(state, layout)(null, theme).render(width);

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

test('missing endpoints show suspension rather than readiness while retaining route and controls', () => {
  for (const [inputAvailable, outputAvailable, badge, activity] of [
    [true, false, 'PLAYBACK SUSPENDED', 'LISTENING - playback suspended'],
    [false, true, 'MIC SUSPENDED', 'LISTENING SUSPENDED'],
    [false, false, 'AUDIO SUSPENDED', 'LISTENING AND PLAYBACK SUSPENDED'],
  ]) {
    const state = { enabled: true, inputAvailable, outputAvailable, route: 'desk', routeActive: true };
    const text = render(state, 80).map(plain).join('\n');
    assert.ok(text.includes(badge), text);
    assert.ok(text.includes(activity), text);
    assert.match(text, /Route: desk/);
    assert.match(text, /\/paj-voice mute/);
    assert.doesNotMatch(text, /READY -|OPEN MIC/);
    assert.ok(plain(voiceStatus(state, theme)).includes(badge));
    for (const width of [4, 12, 40]) assert.ok(render(state, width).every(line => visibleWidth(line) <= width));
  }
});

test('missing playback does not falsely label a paused recognizer as listening', () => {
  const text = render({ enabled: true, inputAvailable: true, outputAvailable: false,
    speakerMode: true, listening: false }, 100).map(plain).join('\n');
  assert.match(text, /RECOGNITION PAUSED - playback suspended/);
  assert.doesNotMatch(text, /LISTENING - playback/);
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
  assert.equal(voiceWidget({}, layout), undefined);
  assert.equal(voiceStatus({}), undefined);
});

test('route is shown only in its bottom row, never beside the open-mic panel heading', () => {
  for (const route of ['desk', 'headset', 'Laptop speakers', '你好 👋']) {
    const state = { ...active, route, routeActive: true };
    const before = structuredClone(state);
    for (const width of [4, 8, 20, 40, 80]) {
      const lines = render(state, width).map(plain);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(lines[0], /desk|headset|Laptop|你好/u);
      const compact = lines.join('').replaceAll(/[│ ]/gu, '');
      assert.ok(compact.includes(`Route:${route.replaceAll(' ', '')}`), compact);
    }
    assert.match(voiceStatus(state), /Route:/);
    assert.deepEqual(state, before);
  }
});

test('the panel fits narrow terminals and retains bounds after invalidation', () => {
  const widget = voiceWidget(active, layout)(null, theme);
  for (const width of [1, 4, 8, 20, 40, 80, 120]) {
    const lines = widget.render(width).map(plain);
    assert.ok(lines.every(line => [...line].length <= width));
  }
  const before = widget.render(80);
  widget.invalidate();
  assert.deepEqual(widget.render(80), before);
});
