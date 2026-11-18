import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, backgroundAudioPolicy } from '../src/config.ts';
import { validFocusSettings, runAudioFocusBroker } from '../src/audio-focus-broker.ts';
import { startAudioFocus } from '../src/audio-focus-client.ts';
import { createAudioFocus } from '../src/audio-focus.ts';
import { fixture } from './fixtures/extension.js';
import { focusFileSystem } from './fixtures/audio-focus-filesystem.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('all-other playback is one explicit opt-in setting while absent configuration remains off', () => {
  assert.equal(validateConfig({}).backgroundAudio, undefined);
  const settings = validateConfig({ backgroundAudio: { enabled: true } }).backgroundAudio;
  assert.deepEqual(settings, { enabled: true, gain: 0.2, ignoreApps: [] });
  assert.equal(validFocusSettings(backgroundAudioPolicy(JSON.parse(JSON.stringify(settings)))), true);
  assert.throws(() => validateConfig({ backgroundAudio: { mode: 'duck', apps: [] } }));
});

test('explicit all-other mode reaches actual playback leases and discloses call and alert lowering', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-all-other-'));
  const make = (id, appId, role, muted = false) => ({ id, serial: String(id), appId,
    binary: appId, role, name: 'stream-' + id, volumes: [1, 0.5], muted });
  const streams = [make(1, '', ''), make(2, 'call-app', 'Communication'),
    make(3, 'alarm-app', 'Alert'), make(4, 'org.paj.voice', 'Music'),
    make(5, 'muted-app', 'Music', true), make(6, 'other-reader', 'Voice')];
  const graph = { async snapshot() { return { generation: 'core', streams: structuredClone(streams) }; },
    async compareAndSet(generation, before, volumes, restore, allOtherPlayback) {
      const stream = streams.find(value => value.serial === before.serial);
      assert.notEqual(stream.appId, 'org.paj.voice');
      assert.equal(stream.muted, false);
      if (generation !== 'core' || JSON.stringify(stream.volumes) !== JSON.stringify(before.volumes)) return false;
      if (volumes[0] < stream.volumes[0]) assert.equal(allOtherPlayback, true);
      else assert.equal(restore, true);
      stream.volumes = [...volumes];
      return true;
    } };
  const focus = createAudioFocus(graph, { releaseMs: 5 });
  const broker = await runAudioFocusBroker({ engine: focus, runtimeDir, env: {}, filesystem: focusFileSystem });
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true, ignoreApps: ['alarm-app'] } }),
    startAudioFocus: settings => startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
      spawn: () => assert.fail('The fake-graph broker already exists') }) });
  t.after(async () => { await f.command('off'); await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }); });
  let consent;
  f.ctx.ui.confirm = async (_title, text) => { consent = text; return true; };
  await f.command('on');
  assert.match(consent, /all other inspectable playback/i);
  assert.match(consent, /calls.*alerts/i);
  assert.match(consent, /Pi Voice.*unchanged/i);
  f.audio({ type: 'ready' });
  f.audio({ type: 'playback_state', id: 'answer', playing: true, outputEpoch: 1, playbackGeneration: 1 });
  const end = Date.now() + 2000;
  while (streams[0].volumes[0] !== 0.2 && Date.now() < end)
    await new Promise(resolve => setTimeout(resolve, 5));
  for (const index of [0, 1, 5]) assert.deepEqual(streams[index].volumes, [0.2, 0.1]);
  for (const index of [2, 3, 4]) assert.deepEqual(streams[index].volumes, [1, 0.5]);
  await f.command('off');
  const restored = Date.now() + 2000;
  while (streams[0].volumes[0] !== 1 && Date.now() < restored)
    await new Promise(resolve => setTimeout(resolve, 5));
  for (const stream of streams) assert.deepEqual(stream.volumes, [1, 0.5]);
});
