import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, runtimeConfig } from '../src/config.ts';

test('background audio has one opt-in switch and optional ignored apps, never sent to the audio model', () => {
  assert.equal(validateConfig({}).audioDucking, undefined);
  const settings = validateConfig({ audioDucking: { enabled: true, ignoreApps: ['org.example.Player'] } });
  assert.deepEqual(settings.audioDucking, {
    enabled: true, gain: 0.2, ignoreApps: ['org.example.Player'],
  });
  const runtime = runtimeConfig(settings, { input: 'mic', output: 'headset' });
  assert.equal(Object.hasOwn(runtime, 'audioDucking'), false);
  assert.equal(Object.hasOwn(runtime.audio, 'audioDucking'), false);
});

test('legacy policies require explicit migration instead of widening an allowlist', () => {
  for (const legacy of [{ mode: 'off' }, { mode: 'duck-all' }, { mode: 'duck', apps: ['music'] },
    { excludeApps: ['call-app'] }, { enabled: true, apps: ['music'] }]) {
    assert.throws(() => validateConfig({ audioDucking: legacy }), /migrate to enabled and ignoreApps/);
  }
});

test('ducking settings fail closed on ambiguous selectors, coercions and unsupported player control', () => {
  for (const audioDucking of [null, [], { enabled: null }, { enabled: 'true' }, { enabled: 1 },
    { ignoreApps: null }, { ignoreApps: '*' }, { ignoreApps: ['*'] }, { ignoreApps: ['app name'] },
    { ignoreApps: ['../program'] }, { ignoreApps: ['x'.repeat(129)] }, { ignoreApps: Array(33).fill('app') },
    { gain: 0 }, { gain: 1.1 }, { gain: '0.2' }, { gain: NaN }, { sink: 'default' }]) {
    assert.throws(() => validateConfig({ audioDucking }), /Invalid voice configuration/);
  }
  assert.deepEqual(validateConfig({ audioDucking: {} }).audioDucking,
    { enabled: false, gain: 0.2, ignoreApps: [] });
});
