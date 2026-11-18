import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, runtimeConfig } from '../src/config.ts';

test('background audio is explicitly opted in with exact app selectors and never sent to the audio model', () => {
  assert.equal(validateConfig({}).backgroundAudio, undefined);
  const settings = validateConfig({ backgroundAudio: { mode: 'duck', apps: ['org.example.Player'] } });
  assert.deepEqual(settings.backgroundAudio, {
    mode: 'duck', gain: 0.2, apps: ['org.example.Player'], excludeApps: [],
  });
  const runtime = runtimeConfig(settings, { input: 'mic', output: 'headset' });
  assert.equal(Object.hasOwn(runtime, 'backgroundAudio'), false);
  assert.equal(Object.hasOwn(runtime.audio, 'backgroundAudio'), false);
});

test('ducking settings fail closed on ambiguous selectors, coercions and unsupported player control', () => {
  for (const backgroundAudio of [null, [], { mode: null }, { mode: 'pause' }, { mode: 'duck' },
    { apps: null }, { excludeApps: null }, { apps: '*' }, { apps: ['*'] }, { apps: ['app name'] },
    { apps: ['../program'] }, { apps: ['x'.repeat(129)] }, { apps: Array(33).fill('app') },
    { gain: 0 }, { gain: 1.1 }, { gain: '0.2' }, { gain: NaN }, { sink: 'default' }]) {
    assert.throws(() => validateConfig({ backgroundAudio }), /Invalid voice configuration/);
  }
  assert.deepEqual(validateConfig({ backgroundAudio: {} }).backgroundAudio,
    { mode: 'off', gain: 0.2, apps: [], excludeApps: [] });
});
