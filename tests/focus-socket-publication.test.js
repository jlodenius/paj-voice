import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, link, rm, lstat, unlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAudioFocusBroker } from '../src/audio-focus-broker.ts';
import { startAudioFocus } from '../src/audio-focus-client.ts';
import { focusFileSystem } from './fixtures/audio-focus-filesystem.js';

const policy = { mode: 'duck-all', gain: 0.2, apps: [], excludeApps: [] };
const waitFor = async (predicate, attempts = 100) => {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Bounded publication condition did not arrive');
};

const engine = () => ({ async set() {}, async close() {} });
const start = options => runAudioFocusBroker({ env: {}, filesystem: focusFileSystem,
  idleMs: 10000, engine: engine(), ...options });

for (let cycle = 0; cycle < 3; cycle++) {
  test(`cold-start clients never observe an unverified public socket during listen (${cycle})`, async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-publication-'));
    const server = createServer();
    const calls = [];
    const diagnostics = [];
    let release;
    let reached;
    const barrier = new Promise(resolve => { release = resolve; });
    const listening = new Promise(resolve => { reached = resolve; });
    const listen = server.listen.bind(server);
    server.listen = (path, callback) => listen(path, async () => {
      await chmod(path, 0o755);
      reached();
      await barrier;
      callback();
    });
    const starting = runAudioFocusBroker({ runtimeDir, env: {}, filesystem: focusFileSystem,
      server, idleMs: 10000, engine: {
        async set(_owner, settings) { calls.push(settings); }, async close() {},
      } });
    const client = startAudioFocus(policy, { runtimeDir, env: {}, filesystem: focusFileSystem,
      onDiagnostic: event => diagnostics.push(event), spawn() {
        const child = new EventEmitter();
        child.unref = () => {};
        return child;
      } });
    let broker;
    try {
      await listening;
      client.playing('synthetic-readout');
      await waitFor(() => diagnostics.some(event => event.reason === 'connect_failed'));
      assert.equal(diagnostics.some(event => event.reason === 'connect_failed' && event.code === 'other'), false);
      await assert.rejects(lstat(join(runtimeDir, 'focus-v1.sock')), { code: 'ENOENT' });
      release();
      broker = await starting;
      assert.equal((await lstat(broker.path)).mode & 0o777, 0o600);
      await waitFor(() => calls.some(settings => settings !== null));
      assert.equal(calls.filter(settings => settings !== null).length, 1);
      client.idle('synthetic-readout');
      await waitFor(() => calls.at(-1) === null);
      client.playing('synthetic-next-readout');
      await waitFor(() => calls.filter(settings => settings !== null).length === 2);
      assert.equal(client.snapshot().terminal, null);
    } finally {
      release();
      await client.close();
      broker ??= await starting;
      await broker.close();
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });
}

test('atomic publication never clobbers a concurrent socket creator', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-collision-'));
  const path = join(runtimeDir, 'focus-v1.sock');
  const server = createServer();
  const other = createServer();
  const listen = server.listen.bind(server);
  let concurrent;
  server.listen = (stagingPath, callback) => listen(stagingPath, async () => {
    await new Promise(resolve => other.listen(path, resolve));
    await chmod(path, 0o600);
    concurrent = await lstat(path);
    callback();
  });
  try {
    await assert.rejects(start({ runtimeDir, server }), { code: 'EEXIST' });
    assert.equal(other.listening, true);
    assert.equal((await lstat(path)).ino, concurrent.ino);
    assert.deepEqual(await readdir(runtimeDir), ['focus-v1.sock']);
  } finally {
    await new Promise(resolve => other.close(resolve));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('shutdown preserves an unrelated replacement of the published pathname', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-replacement-'));
  let broker;
  try {
    broker = await start({ runtimeDir });
    await unlink(broker.path);
    await writeFile(broker.path, 'synthetic replacement', { mode: 0o600 });
    const replacement = await lstat(broker.path);
    await broker.close();
    assert.equal((await lstat(broker.path)).ino, replacement.ino);
    assert.equal(await readFile(broker.path, 'utf8'), 'synthetic replacement');
    assert.deepEqual(await readdir(runtimeDir), ['focus-v1.sock']);
  } finally {
    await broker?.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('the public inode remains owned until engine cleanup finishes', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-cleanup-'));
  let release;
  let entered;
  const cleanup = new Promise(resolve => { release = resolve; });
  const closing = new Promise(resolve => { entered = resolve; });
  const broker = await start({ runtimeDir, engine: { async set() {}, async close() { entered(); await cleanup; } } });
  try {
    const before = await lstat(broker.path);
    const stopped = broker.close();
    await closing;
    assert.equal((await lstat(broker.path)).ino, before.ino);
    await assert.rejects(start({ runtimeDir }), /already running/);
    assert.equal((await lstat(broker.path)).ino, before.ino);
    release();
    await stopped;
    await assert.rejects(lstat(broker.path), { code: 'ENOENT' });
    assert.deepEqual(await readdir(runtimeDir), []);
  } finally {
    release();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('publication cleanup serializes its inode check against a replacement broker', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-cleanup-race-'));
  const path = join(runtimeDir, 'focus-v1.sock');
  let checking = false;
  let release;
  let reached;
  const barrier = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const filesystem = { async lstat(candidate) {
    const stat = await focusFileSystem.lstat(candidate);
    if (candidate === path && checking) {
      checking = false;
      reached();
      await barrier;
    }
    return stat;
  } };
  const broker = await start({ runtimeDir, filesystem });
  let contender;
  let stopped;
  try {
    checking = true;
    stopped = broker.close();
    await entered;
    await assert.rejects(start({ runtimeDir }).then(value => { contender = value; return value; }), { code: 'EEXIST' });
    release();
    await stopped;
    contender = await start({ runtimeDir });
    assert.equal((await lstat(contender.path)).mode & 0o777, 0o600);
  } finally {
    release();
    await stopped;
    await contender?.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('staging preserves the existing 100-byte public socket path limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paj-focus-length-'));
  const runtimeDir = join(root, 'x'.repeat(100 - Buffer.byteLength(root) - 15));
  await mkdir(runtimeDir, { mode: 0o700 });
  let broker;
  try {
    broker = await start({ runtimeDir });
    assert.equal(Buffer.byteLength(broker.path), 100);
    assert.equal((await lstat(broker.path)).mode & 0o777, 0o600);
    await broker.close();
    assert.deepEqual(await readdir(runtimeDir), []);
    const excessive = join(root, 'y'.repeat(101 - Buffer.byteLength(root) - 15));
    await mkdir(excessive, { mode: 0o700 });
    await assert.rejects(start({ runtimeDir: excessive }), /path too long/);
    assert.deepEqual(await readdir(excessive), []);
  } finally {
    await broker?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe staging verification fails closed without publishing or dispatching', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-staging-'));
  let dispatches = 0;
  const filesystem = { async lstat(path) {
    const stat = await focusFileSystem.lstat(path);
    if (path.endsWith('/s')) stat.mode = (stat.mode & ~0o777) | 0o644;
    return stat;
  } };
  try {
    await assert.rejects(start({ runtimeDir, filesystem,
      engine: { async set() { dispatches++; }, async close() {} } }), /Unsafe focus socket/);
    await assert.rejects(lstat(join(runtimeDir, 'focus-v1.sock')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(runtimeDir), []);
    assert.equal(dispatches, 0);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('normal idle disconnect reconnects securely without replaying an old lease', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-reconnect-'));
  const calls = [];
  const broker = await start({ runtimeDir, engine: {
    async set(_owner, settings) { calls.push(settings); }, async close() {},
  } });
  const client = startAudioFocus(policy, { runtimeDir, env: {}, filesystem: focusFileSystem,
    spawn() { assert.fail('Existing synthetic broker must not spawn a worker'); } });
  try {
    client.playing('first');
    await waitFor(() => calls.some(settings => settings !== null));
    client.idle('first');
    await new Promise(resolve => setTimeout(resolve, 2750));
    assert.equal(client.snapshot().state, 'idle');
    assert.equal(client.snapshot().terminal, null);
    client.playing('second');
    await waitFor(() => calls.filter(settings => settings !== null).length === 2);
    assert.equal(client.snapshot().state, 'connected');
    assert.equal(client.snapshot().terminal, null);
    assert.equal(calls.filter(settings => settings !== null).length, 2);
  } finally {
    await client.close();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

async function staleSocket(runtimeDir) {
  const server = createServer();
  const bound = join(runtimeDir, 'dead');
  const path = join(runtimeDir, 'focus-v1.sock');
  await new Promise(resolve => server.listen(bound, resolve));
  try {
    await chmod(bound, 0o600);
    await link(bound, path);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  return path;
}

test('an unchanged private stale socket can be replaced by secure publication', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-stale-'));
  let broker;
  try {
    const path = await staleSocket(runtimeDir);
    const previous = await lstat(path);
    const retained = join(runtimeDir, 'stale-reference');
    await link(path, retained);
    broker = await start({ runtimeDir });
    assert.notEqual((await lstat(path)).ino, previous.ino);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await unlink(retained);
    await broker.close();
    assert.deepEqual(await readdir(runtimeDir), []);
  } finally {
    await broker?.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('a pathname changed after the stale probe is not unlinked', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-stale-race-'));
  const path = await staleSocket(runtimeDir);
  let checks = 0;
  const filesystem = { async lstat(candidate) {
    if (candidate === path && ++checks === 2) {
      await unlink(path);
      await writeFile(path, 'synthetic replacement', { mode: 0o600 });
    }
    return focusFileSystem.lstat(candidate);
  } };
  try {
    await assert.rejects(start({ runtimeDir, filesystem }), /changed during startup/);
    assert.equal(await readFile(path, 'utf8'), 'synthetic replacement');
    assert.deepEqual(await readdir(runtimeDir), ['focus-v1.sock']);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('socket owner, type, symlink and mode checks remain strict before startup', async () => {
  for (const invalid of ['owner', 'type', 'symlink', 'mode']) {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-verification-'));
    const path = join(runtimeDir, 'focus-v1.sock');
    const server = createServer();
    await new Promise(resolve => server.listen(path, resolve));
    await chmod(path, 0o600);
    const filesystem = { async lstat(candidate) {
      const stat = await focusFileSystem.lstat(candidate);
      if (candidate === path) {
        if (invalid === 'owner') stat.uid += 1;
        if (invalid === 'type') stat.isSocket = () => false;
        if (invalid === 'symlink') stat.isSymbolicLink = () => true;
        if (invalid === 'mode') stat.mode = (stat.mode & ~0o777) | 0o644;
      }
      return stat;
    } };
    let dispatches = 0;
    try {
      const before = await lstat(path);
      await assert.rejects(start({ runtimeDir, filesystem, engine: {
        async set() { dispatches++; }, async close() {},
      } }), /Unsafe focus socket/);
      assert.equal((await lstat(path)).ino, before.ino);
      assert.equal(dispatches, 0);
      assert.deepEqual(await readdir(runtimeDir), ['focus-v1.sock']);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }
});

test('terminal unsafe-socket failures remain latched after permissions become valid', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-terminal-'));
  const calls = [];
  const broker = await start({ runtimeDir, engine: {
    async set(_owner, settings) { calls.push(settings); }, async close() {},
  } });
  const client = startAudioFocus(policy, { runtimeDir, env: {}, filesystem: focusFileSystem,
    connect() { assert.fail('Unsafe socket or terminal client must not connect'); },
    spawn() { assert.fail('Unsafe socket must not start a worker'); } });
  try {
    await chmod(broker.path, 0o755);
    client.playing('first');
    await waitFor(() => client.snapshot().state === 'failed');
    await chmod(broker.path, 0o600);
    client.playing('second');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(client.snapshot().state, 'failed');
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
