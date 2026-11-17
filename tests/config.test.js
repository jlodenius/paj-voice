import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig, validateConfig } from '../src/config.js';

export const valid = () => ({ version: 1, languages: ['en'], responseLanguage: 'en',
  stt: { model: '/models/whisper' }, tts: { model: '/models/voice.onnx' },
  audio: { input: 'Echo-Cancel Source', output: 'Echo-Cancel Sink', echoCancellation: 'external' } });

test('English only, local model paths, explicit audio and echo handling are required', () => {
  assert.deepEqual(validateConfig(valid()).languages, ['en']);
  for (const change of [
    { languages: ['en', 'sv'] }, { responseLanguage: 'sv' }, { stt: { model: 'small.en' } },
    { tts: { model: 'https://cloud/voice' } }, { cloudFallback: true },
    { audio: { input: 'default', output: 'default', echoCancellation: 'none' } },
    { turn: { silenceMs: -1 } }, { addressPhrases: [''] }, { python: 'python\nmalicious' },
  ]) assert.throws(() => validateConfig({ ...valid(), ...change }), /Invalid voice configuration/);
});

test('open-mic preferences reject wake phrases, hints and prefix settings', () => {
  const base = valid();
  for (const change of [{ addressPhrases: ['paj'] }, { stt: { ...base.stt, hotwords: 'pie' } },
    { turn: { prefixIntervalMs: 500 } }]) {
    assert.throws(() => validateConfig({ ...base, ...change }), /Invalid voice configuration/);
  }
});

test('timing preferences and bundled model defaults match the qualified open-mic pipeline', () => {
  const config = validateConfig({ ...valid(), turn: { silenceMs: 1800 } });
  assert.equal(Object.hasOwn(config, 'addressPhrases'), false);
  const bundled = validateConfig({ version: 1, audio: { input: 'laptop', output: 'headphones', echoCancellation: 'none' } });
  assert.deepEqual(bundled.stt, { computeType: 'int8' });
  assert.deepEqual(bundled.tts, {});
  assert.equal(bundled.turn.silenceMs, 800);
  assert.equal(bundled.turn.maxSeconds, 12);
  assert.equal(config.turn.silenceMs, 1800);
  assert.equal(config.stt.computeType, 'int8');
  assert.equal(config.tts.config, '/models/voice.onnx.json');
});

function configFile(t, value) {
  const directory = mkdtempSync(join(tmpdir(), 'paj-voice-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'paj.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('shared preferences default to paj.json and explicit paths keep the shared schema', t => {
  assert.equal(configPath({}), join(homedir(), '.pi', 'agent', 'paj.json'));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: '/custom/agent' }), '/custom/agent/paj.json');
  const path = configFile(t, { voice: valid() });
  const alternate = configPath({ PAJ_VOICE_CONFIG: path, PI_CODING_AGENT_DIR: '/ignored' });
  assert.equal(alternate, path);
  assert.deepEqual(loadConfig(alternate), validateConfig(valid()));
  writeFileSync(path, JSON.stringify(valid()));
  assert.throws(() => loadConfig(alternate), /missing voice section/);
});

test('agent directory overrides resolve the same shared path as Captain', () => {
  assert.equal(configPath({ PI_CODING_AGENT_DIR: '~' }), join(homedir(), 'paj.json'));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: '~/custom-agent' }), join(homedir(), 'custom-agent', 'paj.json'));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: './custom-agent' }), join(process.cwd(), 'custom-agent', 'paj.json'));
  assert.equal(configPath({ PAJ_VOICE_CONFIG: 'explicit.json' }), 'explicit.json');
});

test('only the voice section is validated; addon siblings remain opaque and unchanged', t => {
  for (const siblings of [
    { subagents: { version: 234, arbitrary: ['opaque'] }, captain: null },
    { subagents: false, captain: 'not a Voice concern', futureAddon: [null, 7] },
  ]) {
    const path = configFile(t, { ...siblings, voice: valid() });
    const before = readFileSync(path, 'utf8');
    assert.deepEqual(loadConfig(path), validateConfig(valid()));
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('missing voice preferences never fall back to legacy files or automatic defaults', t => {
  const path = configFile(t, { subagents: {}, captain: {} });
  writeFileSync(join(path, '..', 'voice.json'), JSON.stringify(valid()));
  assert.throws(() => loadConfig(path), /missing voice section.*merge a "voice" object.*examples\/paj\.json/);
  writeFileSync(path, '{}');
  assert.throws(() => loadConfig(path), /missing voice section/);
});

test('invalid shared roots, voice sections and malformed JSON fail closed', t => {
  for (const root of [null, false, 3, 'text', [], [valid()]]) {
    assert.throws(() => loadConfig(configFile(t, root)), /shared JSON object with a voice section/);
  }
  for (const voice of [null, false, 3, 'text', [], {}]) {
    assert.throws(() => loadConfig(configFile(t, { voice })), /Invalid voice configuration/);
  }
  const path = configFile(t, { voice: valid() });
  writeFileSync(path, '{"voice":');
  assert.throws(() => loadConfig(path), /Cannot read.*invalid JSON/);
  rmSync(path);
  assert.throws(() => loadConfig(path), /Cannot read.*ENOENT/);
});

test('shared example retains safe spelling defaults and the companion inner schema', () => {
  const example = JSON.parse(readFileSync(new URL('../examples/paj.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example), ['voice']);
  assert.equal(Object.hasOwn(example.voice.stt, 'hotwords'), false);
  assert.equal(validateConfig(example.voice).stt.hotwords, undefined);
});
