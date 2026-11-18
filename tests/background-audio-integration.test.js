import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures/extension.js';
import { focusFileSystem } from './fixtures/audio-focus-filesystem.js';
import { createAudioFocus } from '../src/audio-focus.ts';
import { startAudioFocus } from '../src/audio-focus-client.ts';
import { runAudioFocusBroker } from '../src/audio-focus-broker.ts';

const settings = { mode: 'duck', gain: 0.2, apps: ['org.example.Player'], excludeApps: [] };
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) assert.fail('Timed out waiting for fake graph volume');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function focused(t, enabled = true) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-extension-'));
  const stream = { id: 5, serial: '55', appId: 'org.example.Player', binary: 'player', role: 'Music',
    name: 'player', volumes: [1, 0.5], muted: false };
  const graph = {
    async snapshot() { return { generation: 'cookie', streams: [structuredClone(stream)] }; },
    async compareAndSet(generation, before, volumes) {
      if (generation !== 'cookie' || before.serial !== stream.serial ||
          JSON.stringify(before.volumes) !== JSON.stringify(stream.volumes)) return false;
      stream.volumes = [...volumes];
      return true;
    },
  };
  const engine = createAudioFocus(graph, { releaseMs: 5, pollMs: 20 });
  const broker = await runAudioFocusBroker({ engine, runtimeDir, idleMs: 10000, env: {}, filesystem: focusFileSystem });
  const f = fixture({ loadConfig: () => enabled ? { backgroundAudio: settings } : {},
    startAudioFocus: value => startAudioFocus(value, { runtimeDir, env: {}, filesystem: focusFileSystem,
      spawn: () => assert.fail('The private fake-graph broker is already running') }) });
  t.after(async () => { await f.command('off'); await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }); });
  const playback = (id, playing, playbackGeneration = 1, outputEpoch = 1) =>
    f.audio({ type: 'playback_state', id, playing, playbackGeneration, outputEpoch });
  return { ...f, stream, playback };
}

test('actual readouts own ducking across stale idle, output failure and Voice off', async t => {
  const f = await focused(t);
  await f.command('on');
  f.audio({ type: 'ready' });
  f.playback('first', true);
  await until(() => f.stream.volumes[0] === 0.2);
  f.playback('second', true, 2);
  f.playback('first', false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.stream.volumes, [0.2, 0.1]);
  f.playback('second', false, 2);
  await until(() => f.stream.volumes[0] === 1);
  f.playback('third', true, 3);
  await until(() => f.stream.volumes[0] === 0.2);
  f.audio({ type: 'availability', input: true, output: false });
  await until(() => f.stream.volumes[0] === 1);
  f.audio({ type: 'availability', input: true, output: true });
  f.playback('fourth', true, 1, 2);
  await until(() => f.stream.volumes[0] === 0.2);
  await f.command('off');
  await until(() => f.stream.volumes[0] === 1);
});

test('stop requests retain attenuation until the actual native playback finishes cancelling', async t => {
  const f = await focused(t);
  await f.command('on');
  f.audio({ type: 'ready' });
  f.playback('readout', true);
  await until(() => f.stream.volumes[0] === 0.2);
  await f.command('stop');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.stream.volumes, [0.2, 0.1]);
  f.playback('readout', false);
  await until(() => f.stream.volumes[0] === 1);
});

test('read-only eligibility preview works while Voice is off and never starts a worker', async t => {
  const graph = { async snapshot() { return { generation: 'cookie', streams: [{ id: 3, serial: '3',
    appId: 'org.example.Player', binary: 'player', role: 'Music', name: 'private media label',
    volumes: [1], muted: false }] }; },
    async compareAndSet() { assert.fail('A preview cannot write stream volume'); } };
  const focus = createAudioFocus(graph);
  t.after(() => focus.close());
  const f = fixture({ previewBackgroundAudio: settings => focus.preview(settings) });
  await f.command('ducking preview');
  assert.equal(f.workers.length, 0);
  const notice = f.notices.at(-1)[0];
  assert.match(notice, /read-only/);
  assert.match(notice, /org.example.Player/);
  assert.doesNotMatch(notice, /private media label/);
});

test('default off cannot change volume even when native playback is reported', async t => {
  const f = await focused(t, false);
  await f.command('on');
  f.audio({ type: 'ready' });
  f.playback('answer', true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.stream.volumes, [1, 0.5]);
});

test('mute, session disposal and replaced native callbacks cannot keep or resurrect ducking', async t => {
  const f = await focused(t);
  let consent;
  f.ctx.ui.confirm = async (_title, text) => { consent = text; return true; };
  await f.command('on');
  assert.match(consent, /background applications/);
  assert.match(consent, /Restoration is best effort/);
  assert.match(consent, /not echo cancellation/);
  f.audio({ type: 'ready' });
  const old = f.workers[0];
  f.playback('readout', true);
  await until(() => f.stream.volumes[0] === 0.2);
  await f.command('mute');
  await until(() => f.stream.volumes[0] === 1);
  await f.command('unmute');
  f.audio({ type: 'ready' });
  old.args.onEvent({ type: 'playback_state', id: 'obsolete', playing: true,
    playbackGeneration: 50, outputEpoch: 50 }, old.args.generation);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.stream.volumes, [1, 0.5]);
  f.playback('fresh', true);
  await until(() => f.stream.volumes[0] === 0.2);
  await f.event('session_start');
  await until(() => f.stream.volumes[0] === 1);
});
