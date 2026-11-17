import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
const keys = (value, allowed, name) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(name);
};
const number = (value, fallback, low, high, name) => {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < low || result > high) fail(name);
  return result;
};
const boolean = (value, fallback, name) => {
  if (value !== undefined && typeof value !== 'boolean') fail(name);
  return value ?? fallback;
};
const receipt = (value, fallback, name) => {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !result.trim() || result.length > 60 ||
      result.trim().split(/\s+/u).length > 8 || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) fail(name);
  return result.trim();
};

export function validateConfig(value) {
  keys(value, ['voice', 'volume', 'speed', 'pauseSeconds', 'maxMessageSeconds', 'feedback'],
    'use only voice, volume, speed, pauseSeconds, maxMessageSeconds and feedback; device IDs and runtime tuning are not preferences');
  const voice = value.voice === undefined ? 'ljspeech' : value.voice;
  if (typeof voice !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(voice)) fail('voice must name an installed voice');
  const feedback = value.feedback === undefined ? {} : value.feedback;
  keys(feedback, ['receipt', 'steeringReceipt', 'progressUpdates', 'idleReminders'], 'feedback');
  return {
    voice,
    volume: number(value.volume, 40, 0, 100, 'volume must be 0–100'),
    speed: number(value.speed, 1, 0.5, 2, 'speed must be 0.5–2'),
    pauseSeconds: number(value.pauseSeconds, 0.8, 0.3, 5, 'pauseSeconds must be 0.3–5'),
    maxMessageSeconds: number(value.maxMessageSeconds, 20, 5, 30, 'maxMessageSeconds must be 5–30'),
    feedback: {
      receipt: receipt(feedback.receipt, 'Got it.', 'feedback.receipt must be 1–8 words, at most 60 characters'),
      steeringReceipt: receipt(feedback.steeringReceipt, 'Steering received.',
        'feedback.steeringReceipt must be 1–8 words, at most 60 characters'),
      progressUpdates: boolean(feedback.progressUpdates, true, 'feedback.progressUpdates'),
      idleReminders: boolean(feedback.idleReminders, true, 'feedback.idleReminders'),
    },
  };
}

export function runtimeConfig(preferences, devices) {
  const settings = validateConfig(preferences);
  return { version: 1, languages: ['en'], responseLanguage: 'en',
    stt: { computeType: 'int8' },
    tts: { voice: settings.voice, volume: settings.volume / 100, lengthScale: 1 / settings.speed },
    audio: { input: devices.input, output: devices.output, echoCancellation: 'none' },
    turn: { silenceMs: settings.pauseSeconds * 1000, maxSeconds: settings.maxMessageSeconds,
      speechThreshold: 0.001 } };
}

export function loadConfig(path = configPath()) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${path}: ${error.code ?? 'invalid JSON'}`); }
  if (!object(value)) fail(`${path} must contain a shared JSON object with a voice section`);
  if (!Object.hasOwn(value, 'voice')) {
    fail(`missing voice section in ${path}; merge a "voice" object from examples/paj.json into this file`);
  }
  return validateConfig(value.voice);
}
