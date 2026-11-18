import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createPipeWireFocusGraph } from '../dist/pipewire-focus.js';

const stream = { serial: '91', id: 32, appId: 'org.example.Music', binary: 'music',
  role: 'Music', name: 'music-output', volumes: [1, 0.5], muted: false };
function node(overrides = {}) {
  return { id: 32, type: 'PipeWire:Interface:Node', info: {
    props: { 'object.serial': 91, 'media.class': 'Stream/Output/Audio',
      'application.id': stream.appId, 'application.process.binary': 'music',
      'media.role': 'Music', 'node.name': 'music-output', 'media.title': 'PRIVATE' },
    params: { Props: [{ channelVolumes: [1, 0.5], mute: false }] }, ...overrides } };
}
const dump = nodes => JSON.stringify([{ id: 0, type: 'PipeWire:Interface:Core',
  info: { cookie: 123, props: { 'core.name': 'NOT-GENERATION' } } }, ...nodes]);
test('snapshot exposes only validated playback stream identity and gains', async () => {
  const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout: dump([node()]) }) });
  assert.deepEqual(await graph.snapshot(), { generation: '123', streams: [stream] });
});
test('missing app ID and role remain exactly empty for an explicitly selected binary', async () => {
  const unknown = node();
  delete unknown.info.props['application.id'];
  delete unknown.info.props['media.role'];
  const graph = createPipeWireFocusGraph({ execute: async (_file, args) => args[0] === '--no-colors'
    ? { exitCode: 0, stdout: dump([unknown]) }
    : { exitCode: 0, stdout: args[3] === '' && args[5] === '' ? 'ok\n' : '' } });
  const snapshot = await graph.snapshot();
  assert.deepEqual(snapshot.streams, [{ ...stream, appId: '', role: '' }]);
  assert.equal(await graph.compareAndSet('123', snapshot.streams[0], [0.2, 0.1]), true);
});
test('CAS passes exact expected identity and gains and requires native acknowledgement', async () => {
  const calls = [];
  const graph = createPipeWireFocusGraph({ controlPath: '/fake/control', execute: async (file, args, bounds) => {
    calls.push({ file, args, bounds });
    return { exitCode: 0, stdout: 'ok\n' };
  } });
  assert.equal(await graph.compareAndSet('123', stream, [0.2, 0.1]), true);
  assert.deepEqual(calls[0].args, ['123', '91', '32', stream.appId, 'music', 'Music',
    'music-output', '0', '1,0.5', '0.2,0.1', '0']);
  assert.equal(calls[0].file, '/fake/control');
  assert.ok(calls[0].bounds.timeoutMs <= 2000);
});
test('own tagged and named playback nodes are never exposed or writable', async () => {
  for (const props of [{ 'application.id': 'org.paj.voice' }, { 'paj.voice.owner': 'owner-1' },
    { 'node.name': 'paj_voice_play' }, { 'node.name': 'paj_voice_play-short' },
    { 'node.name': 'paj_voice_playback.anything' }]) {
    const own = node(); Object.assign(own.info.props, props);
    const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout: dump([own]) }) });
    assert.deepEqual((await graph.snapshot()).streams, []);
  }
  let commands = 0;
  const graph = createPipeWireFocusGraph({ execute: async () => { commands++; return { exitCode: 0, stdout: 'ok\n' }; } });
  assert.equal(await graph.compareAndSet('123', { ...stream, appId: 'org.paj.voice' }, [0.2, 0.1]), false);
  assert.equal(await graph.compareAndSet('123', { ...stream, name: 'paj_voice_play-extra' }, [0.2, 0.1]), false);
  assert.equal(commands, 0);
});
test('protected roles use the engine normalized safety vocabulary', async () => {
  let commands = 0;
  const graph = createPipeWireFocusGraph({ execute: async () => { commands++; return { exitCode: 0, stdout: 'ok\n' }; } });
  for (const role of ['Communication', 'PHONE', 'Alert', 'Emergency', 'Notification', 'Event',
    'Accessibility', 'Alarm', 'Ring-tone', 'V.o.i.c.e']) {
    assert.equal(await graph.compareAndSet('123', { ...stream, role }, [0.2, 0.1]), false, role);
  }
  assert.equal(commands, 0);
  assert.equal(await graph.compareAndSet('123', { ...stream, role: 'Production' }, [0.2, 0.1]), true);
});
test('explicit restore can undo attenuation after a stream becomes communication, voice or muted', async () => {
  const requests = [];
  const graph = createPipeWireFocusGraph({ execute: async (_file, args) => {
    requests.push(args); return { exitCode: 0, stdout: 'ok\n' };
  } });
  const held = { ...stream, role: 'Communication', volumes: [0.2, 0.1] };
  assert.equal(await graph.compareAndSet('123', held, [1, 0.5]), false);
  assert.equal(await graph.compareAndSet('123', held, [1, 0.5], true), true);
  const muted = { ...held, muted: true };
  assert.equal(await graph.compareAndSet('123', muted, [1, 0.5]), false);
  assert.equal(await graph.compareAndSet('123', muted, [1, 0.5], true), true);
  const voice = { ...held, role: 'V.o.i.c.e' };
  assert.equal(await graph.compareAndSet('123', voice, [1, 0.5]), false);
  assert.equal(await graph.compareAndSet('123', voice, [1, 0.5], true), true);
  assert.deepEqual(requests.map(args => [args[5], args[7], args[8], args[9], args[10]]),
    [['Communication', '0', '0.2,0.1', '1,0.5', '1'],
      ['Communication', '1', '0.2,0.1', '1,0.5', '1'],
      ['V.o.i.c.e', '0', '0.2,0.1', '1,0.5', '1']]);
});
test('restore rejects attenuation, malformed flags and own voice nodes without execution', async () => {
  let commands = 0;
  const graph = createPipeWireFocusGraph({ execute: async () => { commands++; return { exitCode: 0, stdout: 'ok\n' }; } });
  for (const role of ['Music', 'Communication', 'V.o.i.c.e']) {
    assert.equal(await graph.compareAndSet('123', { ...stream, role }, [1, 0.4], true), false);
  }
  for (const restore of ['true', 1, null]) {
    assert.equal(await graph.compareAndSet('123', stream, [1, 0.5], restore), false);
  }
  assert.equal(await graph.compareAndSet('123', { ...stream, appId: 'org.paj.voice' }, [1, 0.5], true), false);
  assert.equal(await graph.compareAndSet('123', { ...stream, name: 'paj_voice_play-extra' }, [1, 0.5], true), false);
  assert.equal(commands, 0);
});
test('default executables are fixed package paths independent of ambient command lookup', async () => {
  const files = [];
  const graph = createPipeWireFocusGraph({ execute: async (file, args) => {
    files.push(file);
    return { exitCode: 0, stdout: args[0] === '--no-colors' ? dump([node()]) : 'ok\n' };
  } });
  await graph.snapshot();
  assert.equal(await graph.compareAndSet('123', stream, [0.2, 0.1]), true);
  assert.deepEqual(files, [fileURLToPath(new URL('../../../libexec/paj-voice-pw-dump',
    new URL('../dist/pipewire-focus.js', import.meta.url))),
  fileURLToPath(new URL('../../../bin/paj-voice-focus-control',
    new URL('../dist/pipewire-focus.js', import.meta.url)))]);
});
test('snapshot excludes hardware, ambiguous identities, malformed gains and URL metadata', async () => {
  const hardware = node(); hardware.info.props['media.class'] = 'Audio/Sink';
  const malformed = node({ params: { Props: [{ channelVolumes: [null], mute: false }] } });
  const url = node(); url.info.props['node.name'] = 'https://private.example/title';
  const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0,
    stdout: dump([node(), node(), hardware, malformed, url]) }) });
  assert.deepEqual(await graph.snapshot(), { generation: '123', streams: [] });
});
test('snapshot requires Core.info.cookie and sanitizes malformed dump errors', async () => {
  for (const stdout of ['[{"private-title":INVALID}]', JSON.stringify([node()]),
    JSON.stringify([{ type: 'PipeWire:Interface:Core', info: { props: { 'core.cookie': 123 } } }])]) {
    const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout }) });
    await assert.rejects(graph.snapshot(), error => !error.message.includes('private-title'));
  }
});
test('snapshot bounds dump output and hides executor diagnostics', async () => {
  const noisy = createPipeWireFocusGraph({ execute: async () => { throw Error('PRIVATE TITLE'); } });
  await assert.rejects(noisy.snapshot(), error => !error.message.includes('PRIVATE'));
  const huge = createPipeWireFocusGraph({ execute: async (_file, _args, bounds) => {
    assert.ok(bounds.maxOutputBytes <= 4 * 1024 * 1024);
    assert.ok(bounds.timeoutMs <= 2000);
    return { exitCode: 0, stdout: ' '.repeat(bounds.maxOutputBytes + 1) };
  } });
  await assert.rejects(huge.snapshot(), /unavailable/);
});
test('CAS refuses malformed or voice identities without executing any command', async () => {
  let calls = 0;
  const graph = createPipeWireFocusGraph({ execute: async () => { calls++; throw Error('must not run'); } });
  for (const value of [{ ...stream, role: 'Voice' }, { ...stream, id: -1 },
    { ...stream, serial: '91;rm' }, { ...stream, serial: 91 }, { ...stream, muted: undefined }]) {
    assert.equal(await graph.compareAndSet('123', value, [0.2, 0.1]), false);
  }
  assert.equal(await graph.compareAndSet(123, stream, [0.2, 0.1]), false);
  assert.equal(await graph.compareAndSet('123', stream, [NaN, 0.1]), false);
  assert.equal(await graph.compareAndSet('123', stream, [0.1]), false);
  assert.equal(calls, 0);
});
test('CAS fails closed on permission, timeout, missing or malformed acknowledgement', async () => {
  for (const result of [{ exitCode: 1, stdout: 'ok\n' }, { exitCode: 0, stdout: '' },
    { exitCode: 0, stdout: 'ok\nextra' }, null]) {
    const graph = createPipeWireFocusGraph({ execute: async () => {
      if (!result) throw Error('timeout');
      return result;
    } });
    assert.equal(await graph.compareAndSet('123', stream, [0.2, 0.1]), false);
  }
});
