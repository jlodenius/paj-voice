import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { errorCode } from './types.ts';
import type { DeviceSelection, Environment } from './types.ts';
import type { BackgroundAudioSettings } from './audio-focus-types.ts';

export function configPath(env: Environment = process.env) {
  if (env.PAJ_VOICE_CONFIG) return env.PAJ_VOICE_CONFIG;
  const home = homedir();
  const configured = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  const agentDir = configured === '~' ? home : configured.startsWith('~/')
    ? join(home, configured.slice(2)) : resolve(configured);
  return join(agentDir, 'paj.json');
}

function fail(message: string): never { throw new Error(`Invalid voice configuration: ${message}`); }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value: unknown, allowed: string[], name: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(name);
};
const number = (value: unknown, fallback: number, low: number, high: number, name: string): number => {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < low || result > high) fail(name);
  return result;
};
const boolean = (value: unknown, fallback: boolean, name: string): boolean => {
  if (value !== undefined && typeof value !== 'boolean') fail(name);
  return value ?? fallback;
};
const receipt = (value: unknown, fallback: string, name: string): string => {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !result.trim() || result.length > 60 ||
      result.trim().split(/\s+/u).length > 8 || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) fail(name);
  return result.trim();
};

export function isBackgroundAudioSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^\.?[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value);
}

export interface BackgroundAudioPreferences {
  enabled: boolean;
  gain: number;
  ignoreApps: string[];
}

export function validateBackgroundAudio(value: unknown = {}): BackgroundAudioPreferences {
  if (object(value) && ['mode', 'apps', 'excludeApps'].some(key => Object.hasOwn(value, key))) {
    fail('backgroundAudio legacy mode/apps/excludeApps are unsupported; migrate to enabled and ignoreApps. ' +
      'Use enabled:false for off; enabled:true for duck-all. Selected-app duck requires explicit consent ' +
      'to lower all other playback. Rename excludeApps to ignoreApps; remove apps.');
  }
  keys(value, ['enabled', 'gain', 'ignoreApps'], 'backgroundAudio');
  const ignoreApps = value.ignoreApps === undefined ? [] : value.ignoreApps;
  if (!Array.isArray(ignoreApps) || ignoreApps.length > 32 || !ignoreApps.every(isBackgroundAudioSelector)) {
    fail('backgroundAudio.ignoreApps must contain at most 32 exact application IDs or binary names');
  }
  return {
    enabled: boolean(value.enabled, false, 'backgroundAudio.enabled must be true or false'),
    gain: number(value.gain, 0.2, 0.05, 1, 'backgroundAudio.gain must be 0.05–1 linear gain'),
    ignoreApps: [...new Set(ignoreApps as string[])],
  };
}

export function backgroundAudioPolicy(settings: BackgroundAudioPreferences): BackgroundAudioSettings {
  return { mode: settings.enabled ? 'duck-all' : 'off', gain: settings.gain,
    apps: [], excludeApps: [...settings.ignoreApps] };
}

export function validateFocusPolicy(value: unknown = {}): BackgroundAudioSettings {
  keys(value, ['mode', 'gain', 'apps', 'excludeApps'], 'backgroundAudio');
  const mode = value.mode === undefined ? 'off' : value.mode;
  if (mode !== 'off' && mode !== 'duck' && mode !== 'duck-all') fail('backgroundAudio.mode must be off, duck or duck-all');
  const apps = (name: 'apps' | 'excludeApps') => {
    const list = value[name] === undefined ? [] : value[name];
    if (!Array.isArray(list) || list.length > 32 || !list.every(isBackgroundAudioSelector)) {
      fail(`backgroundAudio.${name} must contain at most 32 exact application IDs or binary names`);
    }
    return [...new Set(list as string[])];
  };
  const selected = apps('apps');
  if (mode === 'duck' && selected.length === 0) fail('backgroundAudio.apps must explicitly select applications before ducking');
  return { mode, gain: number(value.gain, 0.2, 0.05, 1, 'backgroundAudio.gain must be 0.05–1 linear gain'),
    apps: selected, excludeApps: apps('excludeApps') };
}

export function normalizeShortcutPhrase(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim()
    .replace(/[.!?。！？…]+$/u, '').trim();
}

function validateShortcuts(value: unknown = undefined): { phrase: string; request: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail('shortcuts must be a list of at most 32 entries');
  const phrases = new Set<string>();
  return Array.from(value, entry => {
    keys(entry, ['phrase', 'request'], 'shortcuts entry');
    if (typeof entry.phrase !== 'string' || typeof entry.request !== 'string') fail('shortcuts phrase/request must be text');
    if (!entry.phrase.trim() || entry.phrase.length > 128 || !entry.request.trim() || entry.request.length > 4096 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(entry.phrase + entry.request)) fail('shortcuts text bounds or control characters');
    const phrase = normalizeShortcutPhrase(entry.phrase);
    if (!phrase || phrases.has(phrase)) fail('shortcuts empty or duplicate normalized phrase');
    if (/(?:^|[^\p{L}\p{N}_])(?:stop|off|pause|mute|unmute|resume|silence|quiet|privacy|microphone|mic|disable)(?:[^\p{L}\p{N}_]|$)/u.test(phrase) ||
        phrase === 'shut up') fail('shortcuts phrase is reserved for audio/privacy control');
    phrases.add(phrase);
    return { phrase: entry.phrase, request: entry.request };
  });
}

export function validateConfig(value: unknown) {
  keys(value, ['voice', 'volume', 'speed', 'pauseSeconds', 'maxMessageSeconds', 'feedback', 'backgroundAudio', 'shortcuts'],
    'use only supported voice preferences; device IDs and runtime tuning are not preferences');
  const voice = value.voice === undefined ? 'ljspeech' : value.voice;
  if (typeof voice !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(voice)) fail('voice must name an installed voice');
  const feedback = value.feedback === undefined ? {} : value.feedback;
  keys(feedback, ['receipt', 'steeringReceipt', 'progressUpdates', 'idleReminders'], 'feedback');
  return {
    voice,
    shortcuts: validateShortcuts(value.shortcuts),
    ...(value.backgroundAudio !== undefined ? { backgroundAudio: validateBackgroundAudio(value.backgroundAudio) } : {}),
    volume: number(value.volume, 40, 0, 100, 'volume must be 0–100'),
    speed: number(value.speed, 1, 0.5, 2, 'speed must be 0.5–2'),
    pauseSeconds: number(value.pauseSeconds, 0.8, 0.3, 5, 'pauseSeconds must be 0.3–5'),
    maxMessageSeconds: number(value.maxMessageSeconds, 120, 5, 120, 'maxMessageSeconds must be 5–120'),
    feedback: {
      receipt: receipt(feedback.receipt, 'Got it.', 'feedback.receipt must be 1–8 words, at most 60 characters'),
      steeringReceipt: receipt(feedback.steeringReceipt, 'Steering received.',
        'feedback.steeringReceipt must be 1–8 words, at most 60 characters'),
      progressUpdates: boolean(feedback.progressUpdates, true, 'feedback.progressUpdates'),
      idleReminders: boolean(feedback.idleReminders, true, 'feedback.idleReminders'),
    },
  };
}

export function runtimeConfig(preferences: unknown, devices: DeviceSelection,
  fallback?: DeviceSelection & { name: string }) {
  const settings = validateConfig(preferences);
  return { version: 1, languages: ['en'], responseLanguage: 'en',
    stt: { computeType: 'int8' },
    tts: { voice: settings.voice, volume: settings.volume / 100, lengthScale: 1 / settings.speed },
    audio: { input: devices.input, output: devices.output, echoCancellation: 'none',
      ...(devices.inputDevice ? { inputDevice: devices.inputDevice } : {}),
      ...(devices.outputDevice ? { outputDevice: devices.outputDevice } : {}),
      ...(devices.speakerMode === true ? { speakerMode: true } : {}),
      ...(fallback ? { fallback: { name: fallback.name, input: fallback.input, output: fallback.output,
        ...(fallback.inputDevice ? { inputDevice: fallback.inputDevice } : {}),
        ...(fallback.outputDevice ? { outputDevice: fallback.outputDevice } : {}),
        ...(fallback.speakerMode === true ? { speakerMode: true } : {}) } } : {}) },
    turn: { silenceMs: settings.pauseSeconds * 1000, maxSeconds: settings.maxMessageSeconds,
      speechThreshold: 0.001 } };
}

export function loadConfig(path = configPath()) {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${path}: ${errorCode(error) ?? 'invalid JSON'}`); }
  if (!object(value)) fail(`${path} must contain a shared JSON object with a voice section`);
  if (!Object.hasOwn(value, 'voice')) {
    fail(`missing voice section in ${path}; merge a "voice" object from examples/paj.json into this file`);
  }
  return validateConfig(value.voice);
}
