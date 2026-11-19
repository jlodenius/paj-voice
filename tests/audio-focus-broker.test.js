import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, lstat, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startAudioFocus as createClient } from '../dist/audio-focus-client.js';
import { runAudioFocusBroker as runBroker } from '../dist/audio-focus-broker.js';
import { createAudioFocus } from '../dist/audio-focus.js';
import { focusFileSystem } from './fixtures/audio-focus-filesystem.js';

const startAudioFocus = (settings, options) => createClient(settings, { env: {}, filesystem: focusFileSystem, ...options });
const runAudioFocusBroker = options => runBroker({ env: {}, filesystem: focusFileSystem, ...options });

const duck = { mode: 'duck', gain: 0.3, apps: ['music'], excludeApps: [] };
const waitFor = async predicate => {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition timed out');
};
async function fixture(t, extra = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-test-'));
  await chmod(runtimeDir, 0o700);
  const calls = [];
  const engine = { async set(owner, settings, immediate = false) { calls.push({ owner, settings, immediate }); }, async close() {} };
  const broker = await runAudioFocusBroker({ runtimeDir, engine, idleMs: 10000, ...extra });
  t.after(async () => { await broker.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  return { runtimeDir, calls, broker };
}
async function peer(t, path) {
  const socket = connect(path);
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  t.after(() => socket.destroy());
  return socket;
}
const frame = (op, extra = {}) => JSON.stringify({ v: 1, id: 1, op, ...extra }) + '\n';

test('off never connects or spawns, including on playing', async () => {
  const fail = () => assert.fail('off performed IO');
  const client = startAudioFocus({ ...duck, mode: 'off' }, { connect: fail, spawn: fail,
    filesystem: { lstat: fail } });
  client.playing('one');
  client.idle('one');
  await client.close();
});

test('unsupported server environments cannot reach a private broker or any socket operation', async t => {
  const { runtimeDir, calls } = await fixture(t);
  const environments = [
    { PIPEWIRE_REMOTE: 'other' }, { PIPEWIRE_RUNTIME_DIR: '/another-runtime' },
    { PIPEWIRE_CONFIG_DIR: '/another-config' }, { PIPEWIRE_PROPS: '{ remote.name = other }' },
    { HOME: '/another-home' }, { XDG_CONFIG_HOME: '/another-config' },
  ];
  for (const env of environments) {
    const warnings = [];
    let io = 0;
    const fail = () => { io++; throw new Error('unsupported target performed IO'); };
    const client = startAudioFocus(duck, { runtimeDir, env, connect: fail, spawn: fail,
      filesystem: { lstat: fail }, onWarning: message => warnings.push(message) });
    client.playing('one');
    await waitFor(() => warnings.length > 0);
    await client.close();
    assert.equal(io, 0);
  }
  assert.equal(calls.length, 0);
});

test('an alternate remote cannot acquire a lease in an existing default-server broker', async t => {
  const { runtimeDir, calls } = await fixture(t);
  let connections = 0;
  let warnings = 0;
  const client = startAudioFocus(duck, { runtimeDir, env: { PIPEWIRE_REMOTE: 'other' },
    connect: path => { connections++; return connect(path); }, onWarning: () => { warnings++; } });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => warnings > 0);
  await client.close();
  assert.equal(connections, 0);
  assert.equal(calls.length, 0);
});

test('explicit standard default environment is accepted without changing the broker target', async t => {
  const { runtimeDir, calls } = await fixture(t);
  const home = userInfo().homedir;
  const client = startAudioFocus(duck, { runtimeDir, env: { HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), PIPEWIRE_REMOTE: 'pipewire-0' } });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => calls.some(call => call.settings));
  await client.close();
});

test('real broker rejects unsupported environment before filesystem or server creation', async () => {
  const fail = () => assert.fail('unsupported real broker performed IO');
  await assert.rejects(runBroker({ env: { PIPEWIRE_REMOTE: 'other' }, filesystem: { lstat: fail } }),
    /default.*PipeWire|PipeWire.*default/);
});

test('two clients use distinct owners; stale idle cannot release newer playing', async t => {
  const { runtimeDir, calls, broker } = await fixture(t);
  const options = { runtimeDir, spawn: () => assert.fail('existing broker must be reused') };
  const first = startAudioFocus(duck, options);
  const second = startAudioFocus(duck, options);
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.equal(calls.length, 0);
  first.playing('old');
  await waitFor(() => calls.filter(call => call.settings).length === 1);
  second.playing('other');
  await waitFor(() => calls.filter(call => call.settings).length === 2);
  const owners = calls.filter(call => call.settings).map(call => call.owner);
  assert.notEqual(owners[0], owners[1]);
  first.playing('new');
  first.idle('old');
  await waitFor(() => calls.filter(call => call.settings).length === 3);
  assert.equal(calls.some(call => call.settings === null), false);
  await first.close();
  assert.ok(calls.some(call => call.owner === owners[0] && call.settings === null));
  assert.equal(calls.some(call => call.owner === owners[1] && call.settings === null), false);
  await second.close();
  const stat = await lstat(broker.path);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('idle grace preserves the connection for delayed warnings and then reconnects', async t => {
  const { runtimeDir, calls } = await fixture(t);
  let connections = 0;
  const client = startAudioFocus(duck, { runtimeDir,
    connect: path => { connections++; return connect(path); } });
  t.after(() => client.close());
  client.playing('first');
  await waitFor(() => calls.some(call => call.settings));
  client.idle('first');
  await waitFor(() => calls.some(call => call.settings === null));
  assert.equal(calls.find(call => call.settings === null).immediate, false);
  await new Promise(resolve => setTimeout(resolve, 2700));
  client.playing('second');
  await waitFor(() => calls.filter(call => call.settings).length === 2);
  assert.equal(connections, 2);
  await client.close();
});

test('close waits for the engine release acknowledgement', async t => {
  let unblock;
  let releasing = false;
  let focused = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const engine = { async set(_owner, settings) {
    if (settings) focused = true;
    else { releasing = true; await gate; }
  }, async close() {} };
  const { runtimeDir } = await fixture(t, { engine });
  const client = startAudioFocus(duck, { runtimeDir });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => focused);
  let closed = false;
  const closing = client.close().then(() => { closed = true; });
  await waitFor(() => releasing);
  assert.equal(closed, false);
  unblock();
  await closing;
  assert.equal(closed, true);
});

test('EOF releases only that connection and heartbeat expiry releases abandoned owners', async t => {
  const { calls, broker } = await fixture(t, { deadlineMs: 100 });
  const first = await peer(t, broker.path);
  const second = await peer(t, broker.path);
  first.write(frame('set', { token: 'same', settings: duck }));
  await waitFor(() => calls.some(call => call.settings));
  const firstOwner = calls.find(call => call.settings).owner;
  second.write(frame('set', { token: 'same', settings: duck }));
  await waitFor(() => calls.filter(call => call.settings).length === 2);
  const secondOwner = calls.filter(call => call.settings)[1].owner;
  first.destroy();
  await waitFor(() => calls.some(call => call.owner === firstOwner && call.settings === null));
  assert.equal(calls.some(call => call.owner === secondOwner && call.settings === null), false);
  await waitFor(() => calls.some(call => call.owner === secondOwner && call.settings === null));
  assert.ok(calls.filter(call => call.settings === null).every(call => call.immediate));
});

test('malformed, oversized, off and impersonated wire commands fail closed', async t => {
  const { calls, broker } = await fixture(t);
  const messages = [
    'not json\n',
    frame('set', { token: 'x', settings: { ...duck, mode: 'off' } }),
    frame('set', { token: 'x', settings: { ...duck, gain: -1 } }),
    frame('set', { token: 'x', settings: duck, owner: 'someone-else' }),
    JSON.stringify({ v: 2, id: 1, op: 'set', token: 'x', settings: duck }) + '\n',
    'x'.repeat(16385),
  ];
  for (const message of messages) {
    const socket = await peer(t, broker.path);
    const ended = new Promise(resolve => socket.once('close', resolve));
    socket.write(message);
    await ended;
  }
  assert.equal(calls.some(call => call.settings !== null), false);
});

test('queued frames are bounded while an engine operation is pending', { timeout: 2000 }, async t => {
  let unblock;
  let entered = false;
  let released = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  t.after(() => unblock());
  const { broker } = await fixture(t, { engine: {
    async set(_owner, settings) {
      if (settings) { entered = true; await gate; }
      else released = true;
    }, async close() {},
  } });
  const socket = await peer(t, broker.path);
  socket.write(frame('set', { token: 'one', settings: duck }));
  await waitFor(() => entered);
  const ended = new Promise(resolve => socket.once('close', resolve));
  socket.write(Array.from({ length: 33 }, () => frame('ping')).join(''));
  await ended;
  unblock();
  await waitFor(() => released);
});

test('broker rejects stale idle tokens even from a raw peer', async t => {
  const { calls, broker } = await fixture(t);
  const socket = await peer(t, broker.path);
  socket.write(frame('set', { token: 'old', settings: duck }));
  socket.write(frame('set', { token: 'new', settings: duck }));
  socket.write(frame('idle', { token: 'old' }));
  socket.write(frame('ping'));
  await new Promise(resolve => socket.once('data', resolve));
  await waitFor(() => calls.filter(call => call.settings).length === 2);
  assert.equal(calls.some(call => call.settings === null), false);
  socket.write(frame('idle', { token: 'new' }));
  await waitFor(() => calls.some(call => call.settings === null));
});

test('unsafe runtime directories and socket symlinks never spawn a helper', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paj-focus-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  const linked = join(root, 'linked');
  await symlink(target, linked);
  const loose = join(root, 'loose');
  await mkdir(loose, { mode: 0o755 });
  const socketDir = join(root, 'socket');
  await mkdir(socketDir, { mode: 0o700 });
  const file = join(root, 'file');
  await writeFile(file, 'untouched');
  await symlink(file, join(socketDir, 'focus-v1.sock'));
  for (const runtimeDir of [linked, loose, socketDir]) {
    const warnings = [];
    const client = startAudioFocus(duck, { runtimeDir,
      spawn: () => assert.fail('unsafe path spawned'), onWarning: message => warnings.push(message) });
    client.playing('one');
    await waitFor(() => warnings.length === 1);
    await client.close();
  }
});

test('foreign ancestor identity remains rejected by the injected filesystem boundary', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-test-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const filesystem = { async lstat(path) {
    const stat = await focusFileSystem.lstat(path);
    if (path === '/') stat.uid = 123456;
    return stat;
  } };
  await assert.rejects(runBroker({ runtimeDir, filesystem,
    engine: { async set() {}, async close() {} } }), /Unsafe focus runtime parent/);
});

test('late idle acknowledgement cannot disconnect newer playing', async t => {
  let unblock;
  let releasing = false;
  const calls = [];
  const gate = new Promise(resolve => { unblock = resolve; });
  const { runtimeDir } = await fixture(t, { engine: {
    async set(owner, settings) {
      calls.push({ owner, settings });
      if (!settings && !releasing) { releasing = true; await gate; }
    }, async close() {},
  } });
  let connections = 0;
  const client = startAudioFocus(duck, { runtimeDir,
    connect: path => { connections++; return connect(path); } });
  t.after(() => client.close());
  client.playing('old');
  await waitFor(() => calls.some(call => call.settings));
  client.idle('old');
  await waitFor(() => releasing);
  client.playing('new');
  unblock();
  await waitFor(() => calls.filter(call => call.settings).length === 2);
  assert.equal(connections, 1);
  await client.close();
});

test('simultaneous broker starts elect one socket owner', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-test-'));
  const calls = [];
  const engine = () => ({ async set(owner, settings) { calls.push({ owner, settings }); }, async close() {} });
  const results = await Promise.allSettled([
    runAudioFocusBroker({ runtimeDir, engine: engine(), idleMs: 10000 }),
    runAudioFocusBroker({ runtimeDir, engine: engine(), idleMs: 10000 }),
  ]);
  const winners = results.filter(result => result.status === 'fulfilled');
  t.after(async () => {
    await Promise.all(winners.map(result => result.value.close()));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  assert.equal(winners.length, 1);
  const client = startAudioFocus(duck, { runtimeDir });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => calls.some(call => call.settings));
  await client.close();
});

test('a broker retains its socket until engine shutdown completes', async t => {
  let unblock;
  let closing = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  t.after(() => unblock());
  const { runtimeDir, broker } = await fixture(t, { engine: {
    async set() {}, async close() { closing = true; await gate; },
  } });
  const before = await lstat(broker.path);
  let complete = false;
  const stopped = broker.close().then(() => { complete = true; });
  await waitFor(() => closing);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(complete, false);
  await assert.rejects(runAudioFocusBroker({ runtimeDir,
    engine: { async set() {}, async close() {} } }), /already running/);
  assert.equal((await lstat(broker.path)).ino, before.ino);
  unblock();
  await stopped;
  await assert.rejects(lstat(broker.path), { code: 'ENOENT' });
});

test('a competing broker cannot replace a live private socket', async t => {
  const { runtimeDir, calls, broker } = await fixture(t);
  const before = await lstat(broker.path);
  await assert.rejects(runAudioFocusBroker({ runtimeDir,
    engine: { async set() {}, async close() {} } }), /already running/);
  const after = await lstat(broker.path);
  assert.equal(after.ino, before.ino);
  const client = startAudioFocus(duck, { runtimeDir });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => calls.some(call => call.settings));
  await client.close();
});

test('idle shutdown follows completed owner release and closes the engine', async t => {
  let unblock;
  let releasing = false;
  let closed = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const { broker } = await fixture(t, { idleMs: 20, engine: {
    async set(_owner, settings) { if (!settings) { releasing = true; await gate; } },
    async close() { closed = true; },
  } });
  const socket = await peer(t, broker.path);
  socket.write(frame('set', { token: 'one', settings: duck }));
  await new Promise(resolve => socket.once('data', resolve));
  socket.destroy();
  await waitFor(() => releasing);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(closed, false);
  unblock();
  await waitFor(() => closed);
  await broker.close();
  await assert.rejects(lstat(broker.path), { code: 'ENOENT' });
});

test('engine failures produce a best-effort client warning and release the owner', async t => {
  const calls = [];
  const { runtimeDir } = await fixture(t, { engine: {
    async set(owner, settings) { calls.push({ owner, settings }); if (settings) throw new Error('native helper exited'); },
    async close() {},
  } });
  const warnings = [];
  const client = startAudioFocus(duck, { runtimeDir, onWarning: message => warnings.push(message) });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => warnings.length > 0 && calls.some(call => call.settings === null));
  await client.close();
});

function fakeGraph() {
  const stream = { id: 5, serial: '55', appId: 'music', binary: 'music', role: 'Music',
    name: 'music', volumes: [1, 0.5], muted: false };
  return { stream, async snapshot() { return { generation: 'cookie', streams: [structuredClone(stream)] }; },
    async compareAndSet(_generation, before, volumes) {
      if (JSON.stringify(before.volumes) !== JSON.stringify(stream.volumes)) return false;
      stream.volumes = [...volumes];
      return true;
    } };
}

test('close acknowledgement awaits immediate real-engine restoration without releasing another owner', async t => {
  const graph = fakeGraph();
  const engine = createAudioFocus(graph, { releaseMs: 10000 });
  const { runtimeDir } = await fixture(t, { engine });
  const first = startAudioFocus(duck, { runtimeDir });
  const second = startAudioFocus({ ...duck, gain: 0.2 }, { runtimeDir });
  t.after(() => Promise.all([first.close(), second.close()]));
  first.playing('one');
  await waitFor(() => graph.stream.volumes[0] === 0.3);
  second.playing('two');
  await waitFor(() => graph.stream.volumes[0] === 0.2);
  await first.close();
  assert.deepEqual(graph.stream.volumes, [0.2, 0.1]);
  await second.close();
  assert.deepEqual(graph.stream.volumes, [1, 0.5]);
});

for (const action of ['EOF', 'half-close EOF', 'close RPC', 'expiry', 'broker close', 'client close']) {
  test(`${action} invalidates an in-flight reconcile before any new stream is ducked`, async t => {
    let unblock;
    let entered = false;
    let releasing = false;
    const writes = [];
    const gate = new Promise(resolve => { unblock = resolve; });
    t.after(() => unblock());
    const streams = [1, 2].map(id => ({ id, serial: String(id), appId: 'music', binary: 'music',
      role: 'Music', name: `music-${id}`, volumes: [1, 0.5], muted: false }));
    const graph = {
      async snapshot() { return { generation: 'cookie', streams: structuredClone(streams) }; },
      async compareAndSet(_generation, before, volumes) {
        if (!entered) { entered = true; await gate; }
        const stream = streams.find(stream => stream.id === before.id);
        if (JSON.stringify(stream.volumes) !== JSON.stringify(before.volumes)) return false;
        stream.volumes = [...volumes];
        writes.push([stream.id, volumes[0]]);
        return true;
      },
    };
    const focus = createAudioFocus(graph, { releaseMs: 10000 });
    const { broker, runtimeDir } = await fixture(t, { deadlineMs: action === 'expiry' ? 50 : 8000, engine: {
      set(owner, settings, immediate) {
        if (settings === null) releasing = true;
        return focus.set(owner, settings, immediate);
      }, close: () => focus.close(),
    } });
    const client = action === 'client close' ? startAudioFocus(duck, { runtimeDir }) : undefined;
    if (client) t.after(() => client.close());
    const socket = client ? undefined : await peer(t, broker.path);
    if (client) client.playing('one');
    else socket.write(frame('set', { token: 'one', settings: duck }));
    await waitFor(() => entered);
    let closing;
    if (action === 'client close') closing = client.close();
    else if (action === 'EOF') socket.destroy();
    else if (action === 'half-close EOF') socket.end();
    else if (action === 'close RPC') socket.write(frame('close') + frame('set', { token: 'late', settings: duck }));
    else if (action === 'broker close') closing = broker.close();
    await waitFor(() => releasing);
    unblock();
    await waitFor(() => writes.some(([id, gain]) => id === 1 && gain === 1));
    if (closing) await closing;
    assert.deepEqual(writes, [[1, 0.3], [1, 1]]);
    assert.deepEqual(streams.map(stream => stream.volumes), [[1, 0.5], [1, 0.5]]);
  });
}

test('delayed real-engine restore faults reach the client during idle grace', async t => {
  const graph = fakeGraph();
  const original = graph.compareAndSet;
  let refuseRestore = false;
  graph.compareAndSet = async (...args) => refuseRestore ? false : original(...args);
  const { runtimeDir } = await fixture(t, { engine: onWarning => createAudioFocus(graph,
    { releaseMs: 40, pollMs: 20, onWarning }) });
  const warnings = [];
  const client = startAudioFocus(duck, { runtimeDir, onWarning: message => warnings.push(message) });
  t.after(() => client.close());
  client.playing('one');
  await waitFor(() => graph.stream.volumes[0] === 0.3);
  warnings.length = 0;
  refuseRestore = true;
  client.idle('one');
  await waitFor(() => warnings.some(message => /restor/i.test(message)));
  await client.close();
});

test('spawn is lazy, detached, same Node and fixed adjacent helper with sanitized environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paj-focus-test-'));
  const runtimeDir = join(root, 'paj-voice-focus');
  const calls = [];
  let broker;
  let starting;
  let spawned;
  t.after(async () => { await starting; await broker?.close(); await rm(root, { recursive: true, force: true }); });
  const client = startAudioFocus(duck, {
    env: { XDG_RUNTIME_DIR: root, PATH: '/bin', NODE_OPTIONS: '--inspect', NODE_PATH: '/hostile', LD_PRELOAD: '/hostile' },
    spawn(file, args, options) {
      spawned = { file, args, options };
      starting = runAudioFocusBroker({ runtimeDir, idleMs: 10000,
        engine: { async set(owner, settings) { calls.push({ owner, settings }); }, async close() {} } })
        .then(value => { broker = value; });
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });
  t.after(() => client.close());
  assert.equal(spawned, undefined);
  client.playing('one');
  await waitFor(() => calls.some(call => call.settings));
  assert.equal(spawned.file, process.execPath);
  assert.deepEqual(spawned.args, [fileURLToPath(new URL('../dist/audio-focus-broker.js', import.meta.url))]);
  assert.equal(spawned.options.detached, true);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.deepEqual(spawned.options.env, { PATH: '/bin', HOME: userInfo().homedir, XDG_RUNTIME_DIR: root });
  await client.close();
});
