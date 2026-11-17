import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig, validateConfig, runtimeConfig } from '../src/config.js';

export const valid = () => ({ voice: 'ljspeech', volume: 40, speed: 1,
  pauseSeconds: 0.8, maxMessageSeconds: 20, feedback: { receipt: 'Got it.',
    steeringReceipt: 'Steering received.', progressUpdates: true, idleReminders: true } });

test('empty preferences provide only normal user choices with documented defaults', () => {
  assert.deepEqual(validateConfig({}), valid());
  assert.deepEqual(validateConfig(valid()), valid());
});

test('technical settings and unknown preferences are rejected rather than silently retained', () => {
  for (const change of [{ version: 1 }, { languages: ['en'] }, { responseLanguage: 'en' },
    { stt: { computeType: 'int8' } }, { tts: { model: '/voice.onnx' } },
    { audio: { input: 'microphone' } }, { turn: { speechThreshold: 0.001 } },
    { python: '/program' }, { cacheDir: '/cache' }, { addressPhrases: ['paj'] },
    { feedback: { unknown: true } }]) {
    assert.throws(() => validateConfig(change), /Invalid voice configuration/);
  }
});

test('user preference types, ranges and short receipt limits are enforced', () => {
  for (const change of [{ volume: null }, { voice: null }, { feedback: null }, { volume: -1 }, { volume: 101 }, { volume: '40' }, { volume: NaN },
    { speed: 0.4 }, { speed: 2.1 }, { pauseSeconds: 0.2 }, { pauseSeconds: 6 },
    { maxMessageSeconds: 4 }, { maxMessageSeconds: 31 }, { voice: '/path/to/voice' },
    { voice: 'https://remote/voice' }, { feedback: { progressUpdates: 1 } },
    { feedback: { idleReminders: 'yes' } }, { feedback: { receipt: '' } },
    { feedback: { receipt: 'a '.repeat(9) } }, { feedback: { receipt: 'x'.repeat(61) } },
    { feedback: { steeringReceipt: 'a\nb' } }]) {
    assert.throws(() => validateConfig(change), /Invalid voice configuration/);
  }
  assert.equal(validateConfig({ volume: 0 }).volume, 0);
  assert.equal(validateConfig({ speed: 2 }).speed, 2);
  assert.equal(validateConfig({ feedback: { progressUpdates: false } }).feedback.idleReminders, true);
});

test('runtime compilation hides compute, language, thresholds and local device bindings', () => {
  const config = runtimeConfig({ volume: 25, speed: 2, pauseSeconds: 1.2 },
    { input: 'laptop', output: 'headphones' });
  assert.deepEqual(config.stt, { computeType: 'int8' });
  assert.deepEqual(config.tts, { voice: 'ljspeech', volume: 0.25, lengthScale: 0.5 });
  assert.deepEqual(config.audio, { input: 'laptop', output: 'headphones', echoCancellation: 'none' });
  assert.deepEqual(config.turn, { silenceMs: 1200, maxSeconds: 20, speechThreshold: 0.001 });
  assert.deepEqual(config.languages, ['en']);
});

function configFile(t, value) {
  const directory = mkdtempSync(join(tmpdir(), 'paj-voice-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'paj.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('shared config paths match Pi conventions and addon siblings are opaque', t => {
  assert.equal(configPath({}), join(homedir(), '.pi', 'agent', 'paj.json'));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: '/custom/agent' }), '/custom/agent/paj.json');
  assert.equal(configPath({ PI_CODING_AGENT_DIR: '~' }), join(homedir(), 'paj.json'));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: '~/custom' }), join(homedir(), 'custom/paj.json'));
  assert.equal(configPath({ PAJ_VOICE_CONFIG: 'explicit.json' }), 'explicit.json');
  const path = configFile(t, { subagents: { opaque: true }, captain: null, voice: {} });
  const before = readFileSync(path, 'utf8');
  assert.deepEqual(loadConfig(path), valid());
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('missing sections, malformed roots and obsolete schemas fail with actionable errors', t => {
  for (const root of [null, false, 3, 'text', []]) {
    assert.throws(() => loadConfig(configFile(t, root)), /shared JSON object/);
  }
  assert.throws(() => loadConfig(configFile(t, {})), /missing voice section/);
  for (const voice of [null, false, 3, 'text', [], { version: 1 }]) {
    assert.throws(() => loadConfig(configFile(t, { voice })), /Invalid voice configuration/);
  }
  const path = configFile(t, { voice: {} });
  writeFileSync(path, '{broken');
  assert.throws(() => loadConfig(path), /Cannot read/);
});

test('the shared example contains only supported user preferences', () => {
  const example = JSON.parse(readFileSync(new URL('../examples/paj.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example), ['voice']);
  assert.deepEqual(validateConfig(example.voice), valid());
});

test('README documents every supported preference', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const keys = Object.entries(validateConfig({})).flatMap(([key, value]) =>
    key === 'feedback' ? Object.keys(value).map(name => `feedback.${name}`) : [key]);
  for (const key of keys) {
    assert.ok(readme.includes('`' + key + '`'), `Undocumented preference: ${key}`);
  }
});
