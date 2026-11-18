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
function helium() {
  const output = node();
  delete output.info.props['application.id'];
  delete output.info.props['application.process.binary'];
  delete output.info.props['media.role'];
  output.info.props['client.id'] = 7;
  const client = { id: 7, type: 'PipeWire:Interface:Client', info: { props: {
    'object.serial': 70, 'application.process.binary': 'helium',
  } } };
  return { output, client };
}
test('minimal playback Node inherits identity only from its exact associated immutable Client', async () => {
  const { output, client } = helium();
  const calls = [];
  const graph = createPipeWireFocusGraph({ execute: async (_file, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: args[0] === '--no-colors' ? dump([output, client]) : 'ok\n' };
  } });
  const snapshot = await graph.snapshot();
  assert.deepEqual(snapshot.streams, [{ ...stream, appId: '', binary: 'helium', role: '',
    associatedClient: { id: 7, serial: '70', source: 'client', appId: '', binary: 'helium',
      role: '', name: '', applicationName: '' } }]);
  assert.equal(await graph.compareAndSet('123', snapshot.streams[0], [0.2, 0.1]), true);
  assert.deepEqual(calls[1].slice(11), ['client', '7', '70', '', 'helium', '', '', '']);
});
test('inheritance rejects malformed and ambiguous association, never guesses or repairs Node identity', async () => {
  for (const mutate of [
    ({ output }) => { output.info.props['client.id'] = null; },
    ({ output }) => { output.info.props['client.id'] = '07'; },
    ({ output }) => { output.info.props['application.id'] = null; },
    ({ output }) => { output.info.props['application.process.binary'] = 42; },
    ({ output }) => { output.info.props['application.id'] = 'https://example.invalid'; },
    ({ client }) => { delete client.info.props['object.serial']; },
    ({ client }) => { client.info.props['application.id'] = null; },
    ({ client }) => { client.id = 8; },
    ({ client, objects }) => { objects.push(structuredClone(client)); },
    ({ client, objects }) => { objects.push({ ...structuredClone(client), id: 8 }); },
    ({ client, objects }) => { objects.push({ id: client.id, type: 'PipeWire:Interface:Node' }); },
  ]) {
    const fixture = helium(); fixture.objects = [fixture.output, fixture.client]; mutate(fixture);
    const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout: dump(fixture.objects) }) });
    assert.deepEqual((await graph.snapshot()).streams, []);
  }
});
test('partial Node identity stays exclusive while either Client or Node protects calls and Voice', async () => {
  for (const own of [{ 'application.id': 'org.paj.voice' }, { 'paj.voice.owner': '' },
    { 'node.name': 'paj_voice_play-extra' }, { 'application.name': 'paj_voice_play-extra' },
    { 'node.name': 'paj_voice_play: stream (1)' }, { 'application.name': 'paj_voice_play: stream (1)' }]) {
    const { output, client } = helium(); Object.assign(client.info.props, own);
    const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout: dump([output, client]) }) });
    assert.deepEqual((await graph.snapshot()).streams, []);
  }
  const { output, client } = helium();
  output.info.props['application.id'] = 'org.node.Player';
  client.info.props['media.role'] = 'Communication';
  let commands = 0;
  const graph = createPipeWireFocusGraph({ execute: async (_file, args) => {
    if (args[0] !== '--no-colors') commands++;
    return { exitCode: 0, stdout: args[0] === '--no-colors' ? dump([output, client]) : 'ok\n' };
  } });
  const [actual] = (await graph.snapshot()).streams;
  assert.equal(actual.appId, 'org.node.Player'); assert.equal(actual.binary, '');
  assert.equal(actual.associatedClient.source, 'node');
  assert.equal(await graph.compareAndSet('123', actual, [0.2, 0.1]), false);
  assert.equal(commands, 0);
  assert.equal(await graph.compareAndSet('123', { ...actual, volumes: [0.2, 0.1] }, [1, 0.5], true), true);
});
test('CAS rejects malformed Client provenance and never omits an invalid association payload', async () => {
  const { output, client } = helium();
  const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout: dump([output, client]) }) });
  const [inherited] = (await graph.snapshot()).streams;
  let commands = 0;
  const writer = createPipeWireFocusGraph({ execute: async () => { commands++; return { exitCode: 0, stdout: 'ok\n' }; } });
  for (const malformed of [null, false, {}, { ...inherited.associatedClient, serial: 70 },
    { ...inherited.associatedClient, id: 32 }, { ...inherited.associatedClient, serial: '91' },
    { ...inherited.associatedClient, source: 'guess' }, { ...inherited.associatedClient, binary: 'other' },
    { ...inherited.associatedClient, name: 'paj_voice_play' },
    { ...inherited.associatedClient, applicationName: 'https://invalid.example' }]) {
    assert.equal(await writer.compareAndSet('123', { ...inherited, associatedClient: malformed }, [0.2, 0.1]), false);
  }
  assert.equal(commands, 0);
});
test('all-other playback inspects anonymous Nodes with or without an immutable associated Client', async () => {
  for (const associated of [false, true]) {
    const { output, client } = helium();
    delete client.info.props['application.process.binary'];
    if (!associated) delete output.info.props['client.id'];
    const calls = [];
    const graph = createPipeWireFocusGraph({ execute: async (_file, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: args[0] === '--no-colors' ? dump([output, client]) : 'ok\n' };
    } });
    const [anonymous] = (await graph.snapshot()).streams;
    assert.ok(anonymous); assert.equal(anonymous.appId, ''); assert.equal(anonymous.binary, '');
    assert.equal(await graph.compareAndSet('123', anonymous, [0.2, 0.1]), false);
    assert.equal(await graph.compareAndSet('123', anonymous, [0.2, 0.1], false, true), true);
    assert.equal(calls[1].at(-1), '1'); assert.equal(calls[1].length, associated ? 20 : 12);
    assert.equal(await graph.compareAndSet('123', { ...anonymous, volumes: [0.2, 0.1] }, [1, 0.5], true), true);
  }
});
test('only explicit all-other flag permits new call, alert and other Voice-role attenuation', async () => {
  const calls = [];
  const graph = createPipeWireFocusGraph({ execute: async (_file, args) => {
    calls.push(args); return { exitCode: 0, stdout: 'ok\n' };
  } });
  for (const role of ['Communication', 'Alert', 'V.o.i.c.e']) {
    const call = { ...stream, role };
    assert.equal(await graph.compareAndSet('123', call, [0.2, 0.1]), false);
    assert.equal(await graph.compareAndSet('123', call, [0.2, 0.1], false, true), true);
    assert.equal(await graph.compareAndSet('123', { ...call, muted: true }, [0.2, 0.1], false, true), false);
    assert.equal(await graph.compareAndSet('123', call, [0.2, 0.1], true, true), false);
  }
  for (const flag of [1, 'true', null]) assert.equal(await graph.compareAndSet('123', stream, [0.2, 0.1], false, flag), false);
  for (const own of [{ appId: 'org.paj.voice' }, { name: 'paj_voice_play-extra' }])
    assert.equal(await graph.compareAndSet('123', { ...stream, ...own }, [0.2, 0.1], false, true), false);
  assert.equal(calls.length, 3);
});
test('printable metadata labels are preserved literally for anonymous playback CAS, never used as selectors', async () => {
  const { output, client } = helium();
  const label = 'Audio output: stream (1)', appLabel = 'Application: playback (1)';
  output.info.props['node.name'] = label;
  output.info.props['application.name'] = appLabel;
  client.info.props['node.name'] = label;
  client.info.props['application.name'] = appLabel;
  delete client.info.props['application.process.binary'];
  const calls = [];
  const graph = createPipeWireFocusGraph({ execute: async (_file, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: args[0] === '--no-colors' ? dump([output, client]) : 'ok\n' };
  } });
  const [actual] = (await graph.snapshot()).streams;
  assert.ok(actual); assert.equal(actual.name, label); assert.equal(actual.appId, ''); assert.equal(actual.binary, '');
  assert.equal(await graph.compareAndSet('123', actual, [0.2, 0.1], false, true), true);
  assert.equal(calls[1][6], label); assert.equal(calls[1][17], label); assert.equal(calls[1][18], appLabel);
  assert.deepEqual(calls[1].slice(3, 6), ['', '', '']);
  assert.equal(await graph.compareAndSet('123', { ...actual, name: 'a'.repeat(256) }, [0.2, 0.1], false, true), true);
});
test('metadata labels reject controls, URLs and excessive lengths without executing a write', async () => {
  for (const field of ['node', 'client', 'application', 'node-application']) {
    for (const label of ['bad\u0000name', 'bad\nname', 'bad\u007fname', 'https://example.invalid', 'a'.repeat(257), 'naïve']) {
      const { output, client } = helium();
      if (field === 'node') output.info.props['node.name'] = label;
      if (field === 'client') client.info.props['node.name'] = label;
      if (field === 'application') client.info.props['application.name'] = label;
      if (field === 'node-application') output.info.props['application.name'] = label;
      const graph = createPipeWireFocusGraph({ execute: async () => ({ exitCode: 0, stdout: dump([output, client]) }) });
      assert.deepEqual((await graph.snapshot()).streams, []);
    }
  }
  let writes = 0;
  const writer = createPipeWireFocusGraph({ execute: async () => { writes++; return { exitCode: 0, stdout: 'ok\n' }; } });
  for (const label of ['bad\u0000name', 'bad\nname', 'bad\u007fname', 'https://example.invalid', 'a'.repeat(257)]) {
    assert.equal(await writer.compareAndSet('123', { ...stream, name: label }, [0.2, 0.1], false, true), false);
  }
  assert.equal(writes, 0);
});
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
    { 'node.name': 'paj_voice_playback.anything' }, { 'node.name': 'paj_voice_play: stream (1)' }]) {
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
