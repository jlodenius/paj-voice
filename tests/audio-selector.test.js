import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackgroundAudio, backgroundAudioPolicy, loadConfig } from '../src/config.ts';
import { validFocusSettings, runAudioFocusBroker } from '../src/audio-focus-broker.ts';
import { startAudioFocus } from '../src/audio-focus-client.ts';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { focusFileSystem } from './fixtures/audio-focus-filesystem.js';
import { createAudioFocus } from '../src/audio-focus.ts';

test('literal Nix-wrapped executable selectors round-trip through configuration, wire and preview', async () => {
  const preferences = validateBackgroundAudio({ enabled: true, gain: 0.2,
    ignoreApps: ['.Discord-wrapped'] });
  assert.deepEqual(preferences.ignoreApps, ['.Discord-wrapped']);
  const settings = backgroundAudioPolicy(preferences);
  assert.equal(validFocusSettings(JSON.parse(JSON.stringify(settings))), true);
  const graph = { async snapshot() { return { generation: 'core', streams: [{ id: 3, serial: '13',
    appId: '', binary: '.spotify-wrapped', role: 'Music', name: 'spotify',
    volumes: [1, 0.5], muted: false }] }; },
    async compareAndSet() { assert.fail('A preview cannot change gains'); } };
  const focus = createAudioFocus(graph);
  try {
    const preview = await focus.preview(settings);
    assert.deepEqual(preview.available, ['.spotify-wrapped']);
    assert.deepEqual(preview.eligible, ['.spotify-wrapped']);
  } finally { await focus.close(); }
});

test('wrapped selectors persist in shared JSON without changing sibling settings or speech preferences', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-wrapped-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'paj.json');
  const shared = { captain: { enabled: false }, voice: { voice: 'ljspeech', pauseSeconds: 2,
    backgroundAudio: { enabled: true, gain: 0.2, ignoreApps: ['helium', '.spotify-wrapped'] } } };
  const before = JSON.stringify(shared);
  await writeFile(file, before);
  const loaded = loadConfig(file);
  assert.deepEqual(loaded.backgroundAudio, shared.voice.backgroundAudio);
  assert.equal(loaded.pauseSeconds, 2);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('wrapped ignored apps survive the real client and private broker lease', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-wrapped-selector-'));
  const streams = [
    { id: 3, serial: '13', appId: '', binary: '.spotify-wrapped', role: 'Music', name: 'spotify',
      volumes: [1, 0.5], muted: false },
    { id: 4, serial: '14', appId: '', binary: '.Discord-wrapped', role: 'Music', name: 'discord',
      volumes: [1, 1], muted: false },
  ];
  const graph = { async snapshot() { return { generation: 'core', streams: structuredClone(streams) }; },
    async compareAndSet(generation, expected, volumes) {
      const current = streams.find(stream => stream.serial === expected.serial);
      if (generation !== 'core' || !current ||
          JSON.stringify(current.volumes) !== JSON.stringify(expected.volumes)) return false;
      current.volumes = [...volumes];
      return true;
    } };
  const focus = createAudioFocus(graph);
  const broker = await runAudioFocusBroker({ env: {}, filesystem: focusFileSystem, runtimeDir,
    engine: focus, idleMs: 10000 });
  const settings = backgroundAudioPolicy(validateBackgroundAudio({ enabled: true, gain: 0.2,
    ignoreApps: ['.Discord-wrapped'] }));
  const client = startAudioFocus(settings, { env: {}, filesystem: focusFileSystem, runtimeDir,
    spawn: () => assert.fail('The fake-graph broker already exists') });
  t.after(async () => { await client.close(); await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }); });
  client.playing('readout');
  const end = Date.now() + 2000;
  while (streams[0].volumes[0] !== 0.2 && Date.now() < end)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(streams[0].volumes, [0.2, 0.1]);
  assert.deepEqual(streams[1].volumes, [1, 1]);
  await client.close();
  assert.deepEqual(streams[0].volumes, [1, 0.5]);
});

test('wrapped selectors remain bounded literal identifiers, never paths or patterns', () => {
  for (const selector of ['.', '..', '..player', '.-player', '/spotify', './spotify',
    '.spotify/*', '.spotify?', '.spotify[0]', '.spotify\n', '.spotify wrapped',
    '.' + 'a'.repeat(128)]) {
    assert.throws(() => validateBackgroundAudio({ enabled: true, ignoreApps: [selector] }));
    assert.equal(validFocusSettings({ mode: 'duck', gain: 0.2, apps: [selector], excludeApps: [] }), false);
  }
  for (const selector of ['spotify', '.spotify-wrapped', '.Discord-wrapped', '.' + 'a'.repeat(127)]) {
    const settings = validateBackgroundAudio({ enabled: true, ignoreApps: [selector] });
    assert.equal(validFocusSettings(backgroundAudioPolicy(settings)), true);
    assert.equal(settings.ignoreApps[0], selector);
  }
});
