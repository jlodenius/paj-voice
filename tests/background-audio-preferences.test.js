import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/extension.js';
import { createAudioFocus } from '../src/audio-focus.ts';

test('preview exposes the enabled switch and ignores apps without writing gains', async t => {
  const focus = createAudioFocus({
    async snapshot() {
      return { generation: 'core', streams: ['music', 'calls'].map((appId, id) => ({
        id, serial: String(id), appId, binary: appId, name: appId, role: 'Communication',
        volumes: [1], muted: false,
      })) };
    },
    async compareAndSet() { assert.fail('Preview must never write gains'); },
  });
  t.after(() => focus.close());
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true, ignoreApps: ['calls'] } }),
    previewBackgroundAudio: settings => focus.preview(settings) });
  await f.command('ducking preview');
  const notice = f.notices.at(-1)[0];
  assert.match(notice, /"enabled":true/);
  assert.match(notice, /"eligible":\["music"\]/);
  assert.doesNotMatch(notice, /"mode"/);
  assert.equal(f.workers.length, 0);
});

test('arming snapshots enabled and ignored apps until the next manual off/on', async t => {
  const preferences = { backgroundAudio: { enabled: true, ignoreApps: ['calls'], gain: 0.3 } };
  const policies = [];
  const f = fixture({ loadConfig: () => preferences,
    startAudioFocus: settings => {
      policies.push(settings);
      return { playing() {}, idle() {}, async close() {} };
    } });
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  preferences.backgroundAudio.enabled = false;
  preferences.backgroundAudio.ignoreApps.push('music');
  f.audio({ type: 'playback_state', id: 'first', playing: true, outputEpoch: 1, playbackGeneration: 1 });
  assert.deepEqual(policies, [{ mode: 'duck-all', gain: 0.3, apps: [], excludeApps: ['calls'] }]);
  await f.command('off');
  await f.command('on');
  f.audio({ type: 'ready' });
  f.audio({ type: 'playback_state', id: 'next', playing: true, outputEpoch: 1, playbackGeneration: 1 });
  assert.equal(policies.length, 1);
});
