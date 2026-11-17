import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../src/runtime-paths.js';
import { validateConfig } from '../src/config.js';

const valid = () => ({ version: 1,
  audio: { input: 'microphone', output: 'headphones', echoCancellation: 'none' } });

test('the installed package owns its executable and cache uses XDG defaults', () => {
  const paths = runtimePaths({}, '/home/test');
  assert.equal(paths.executable, fileURLToPath(new URL('../../../bin/paj-voice-audio',
    new URL('../src/runtime-paths.js', import.meta.url))));
  assert.equal(paths.cacheDir, '/home/test/.cache/paj-voice');
  assert.equal(runtimePaths({ XDG_CACHE_HOME: '/custom/cache' }, '/home/test').cacheDir,
    '/custom/cache/paj-voice');
  assert.throws(() => runtimePaths({ XDG_CACHE_HOME: 'relative' }, '/home/test'), /absolute/);
});

test('runtime plumbing is neither accepted nor returned as user preferences', () => {
  const config = validateConfig(valid());
  assert.equal(Object.hasOwn(config, 'python'), false);
  assert.equal(Object.hasOwn(config, 'cacheDir'), false);
  assert.throws(() => validateConfig({ ...valid(), python: '/arbitrary/program' }), /configuration/);
  assert.throws(() => validateConfig({ ...valid(), cacheDir: '/arbitrary/cache' }), /configuration/);
});
