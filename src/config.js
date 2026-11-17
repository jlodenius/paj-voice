import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function configPath(env = process.env) {
  if (env.PAJ_VOICE_CONFIG) return env.PAJ_VOICE_CONFIG;
  const home = homedir();
  const configured = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  const agentDir = configured === '~' ? home : configured.startsWith('~/')
    ? join(home, configured.slice(2)) : resolve(configured);
  return join(agentDir, 'paj.json');
}

const fail = message => { throw new Error(`Invalid voice configuration: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max = 1024) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(name);
  return value;
};
const keys = (value, allowed, name) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(name);
};

export function validateConfig(value) {
  keys(value, ['version', 'languages', 'responseLanguage', 'python', 'cacheDir', 'stt', 'tts', 'audio', 'turn'], 'unknown field; remove addressPhrases and wake/prefix settings');
  if (value.version !== 1) fail('version must be 1');
  const languages = value.languages ?? ['en'], responseLanguage = value.responseLanguage ?? 'en';
  if (!Array.isArray(languages) || languages.length !== 1 || languages[0] !== 'en' || responseLanguage !== 'en') {
    fail('this runtime supports English only');
  }
  const stt = value.stt ?? {}, tts = value.tts ?? {};
  keys(stt, ['model', 'computeType'], 'stt; recognition hints are not supported');
  keys(tts, ['model', 'config'], 'tts');
  const local = (path, name) => {
    if (path === undefined) return undefined;
    if (!isAbsolute(text(path, name))) fail(name + ' must be an absolute local path');
    return path;
  };
  const model = local(stt.model, 'stt.model');
  const ttsModel = local(tts.model, 'tts.model');
  const ttsConfig = local(tts.config ?? (ttsModel ? ttsModel + '.json' : undefined), 'tts.config');
  const computeType = stt.computeType ?? 'int8';
  if (!['int8', 'float32'].includes(computeType)) fail('stt.computeType');
  keys(value.audio, ['input', 'output', 'echoCancellation'], 'audio');
  const input = text(value.audio.input, 'audio.input'), output = text(value.audio.output, 'audio.output');
  if (input === 'default' || output === 'default' || input.startsWith('bluez')) fail('use exact nodes and a non-Bluetooth microphone');
  if (!['none', 'external'].includes(value.audio.echoCancellation)) fail('audio.echoCancellation must explicitly be none or external; headphones are required');
  const turn = value.turn ?? {};
  keys(turn, ['silenceMs', 'maxSeconds', 'speechThreshold'], 'turn; prefix detection is not supported');
  const number = (key, fallback, min, max) => {
    const result = turn[key] ?? fallback;
    if (!Number.isFinite(result) || result < min || result > max) fail('turn.' + key);
    return result;
  };
  return {
    version: 1, languages: ['en'], responseLanguage: 'en',
    python: text(value.python ?? 'paj-voice-audio', 'python'),
    cacheDir: local(value.cacheDir ?? resolve('.cache/paj-voice'), 'cacheDir'),
    stt: { ...(model ? { model } : {}), computeType },
    tts: { ...(ttsModel ? { model: ttsModel } : {}), ...(ttsConfig ? { config: ttsConfig } : {}) },
    audio: { input, output, echoCancellation: value.audio.echoCancellation },
    turn: { silenceMs: number('silenceMs', 800, 300, 5000),
      maxSeconds: number('maxSeconds', 12, 5, 30),
      speechThreshold: number('speechThreshold', 0.001, 0.001, 0.2) },
  };
}

export function loadConfig(path = configPath()) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${path}: ${error.code ?? 'invalid JSON'}`); }
  if (!object(value)) fail(`${path} must contain a shared JSON object with a voice section`);
  if (!Object.hasOwn(value, 'voice')) {
    fail(`missing voice section in ${path}; merge a "voice" object from examples/paj.json into this file`);
  }
  if (!object(value.voice)) fail(`voice section in ${path} must be an object`);
  return validateConfig(value.voice);
}
