import test from 'node:test';
import assert from 'node:assert/strict';
import { startAudioFocus } from '../src/audio-focus-client.ts';
import { createServer, Socket } from 'node:net';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { focusFileSystem } from './fixtures/audio-focus-filesystem.js';
import { EventEmitter } from 'node:events';
import { createFocusDiagnosticLog, createFocusDiagnosticSender } from '../src/audio-focus-diagnostics.ts';
import { runAudioFocusBroker } from '../src/audio-focus-broker.ts';
import { createPipeWireFocusGraph } from '../src/pipewire-focus.ts';
import { fixture } from './fixtures/extension.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected bounded diagnostic did not arrive');
};

const settings = { mode: 'duck-all', gain: 0.2, apps: [], excludeApps: [] };

test('a malformed broker reply records protocol failure without retaining the reply', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-diagnostic-'));
  const path = join(runtimeDir, 'focus-v1.sock');
  const server = createServer(socket => socket.on('data', () => socket.write('private-sensitive-reply\n')));
  await new Promise(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  const diagnostics = [];
  const client = startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
    onDiagnostic: event => diagnostics.push(event), spawn: () => assert.fail('Mock socket already exists') });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  client.playing('private-token');
  await waitFor(() => diagnostics.some(event => event.reason === 'protocol_invalid'));
  await client.close();
  assert.ok(diagnostics.some(event => event.component === 'client' && event.operation === 'protocol'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-sensitive-reply|private-token|paj-focus-diagnostic-/);
});

test('missing acknowledgements identify the request operation and do not retry writes', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-ack-diagnostic-'));
  const path = join(runtimeDir, 'focus-v1.sock');
  const operations = [];
  const server = createServer(socket => socket.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) operations.push(JSON.parse(line).op);
  }));
  await new Promise(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  const diagnostics = [];
  const client = startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
    onDiagnostic: event => diagnostics.push(event), spawn: () => assert.fail('Mock socket already exists') });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  client.playing('one');
  await waitFor(() => diagnostics.some(event => event.reason === 'ack_timeout'), 3500);
  const timeout = diagnostics.find(event => event.reason === 'ack_timeout');
  assert.equal(timeout.operation, 'set');
  assert.equal(timeout.timeoutMs, 2500);
  assert.ok(timeout.elapsedMs >= 2400);
  client.playing('later');
  await client.close();
  assert.equal(operations.filter(operation => operation === 'set').length, 1);
  assert.ok(diagnostics.some(event => event.reason === 'ack_timeout'));
});

test('broker startup exit and safe IPC reason survive client cleanup without stderr collection', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-startup-diagnostic-'));
  const diagnostics = [];
  const client = startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
    onDiagnostic: event => diagnostics.push(event),
    spawn(_file, _args, options) {
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => {
        child.emit('message', { type: 'paj-voice-focus-diagnostic', event: {
          component: 'broker', operation: 'startup', reason: 'startup_failed',
          code: 'EACCES', rawMessage: 'private-secret-path',
        } });
        child.emit('message', { type: 'paj-voice-focus-diagnostic', event: {
          component: 'broker', operation: 'startup', reason: 'startup_failed', code: 'EACCES',
        } });
        child.emit('exit', 1, null);
      });
      return child;
    } });
  t.after(async () => { await client.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  client.playing('one');
  await waitFor(() => diagnostics.some(event => event.reason === 'startup_failed'));
  await client.close();
  assert.ok(diagnostics.some(event => event.reason === 'broker_exit' && event.exitCode === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-secret-path|rawMessage/);
});

test('safe history is bounded, expires, rejects sensitive fields, and returns independent snapshots', () => {
  let now = 0;
  const log = createFocusDiagnosticLog(() => now);
  const event = { component: 'client', operation: 'set', reason: 'ack_timeout', timeoutMs: 2500 };
  log.record({ ...event, text: 'private-transcript' });
  log.record({ ...event, code: 'private-secret' });
  assert.equal(log.snapshot().length, 0);
  for (let index = 0; index < 40; index++) { now = index; log.record(event); }
  assert.equal(log.snapshot().length, 32);
  const snapshot = log.snapshot();
  snapshot[0].reason = 'private-secret';
  assert.equal(log.snapshot()[0].reason, 'ack_timeout');
  now += 900000;
  assert.deepEqual(log.snapshot(), []);
});

test('broker operation failures reach the client as bounded safe diagnostics and survive cleanup', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-broker-diagnostic-'));
  const log = createFocusDiagnosticLog();
  const broker = await runAudioFocusBroker({ runtimeDir, env: {}, filesystem: focusFileSystem, idleMs: 10000,
    engine: { async set(_owner, policy) { if (policy) throw new Error('private-secret-engine-message'); },
      async close() {} } });
  const client = startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
    onDiagnostic: event => log.record(event), spawn: () => assert.fail('Fake broker already exists') });
  t.after(async () => { await client.close(); await broker.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  client.playing('private-token');
  await waitFor(() => log.snapshot().some(event => event.component === 'broker' && event.reason === 'request_failed'));
  await client.close();
  const failure = log.snapshot().find(event => event.component === 'broker' && event.reason === 'request_failed');
  assert.equal(failure.operation, 'set');
  assert.ok(Number.isInteger(failure.elapsedMs));
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private-secret-engine-message|private-token|paj-focus-broker-/);
});

test('native adapter diagnostics distinguish exit, timeout and malformed acknowledgement without stream data', async () => {
  const stream = { id: 1, serial: '2', appId: 'player', binary: 'player', role: 'Music',
    name: 'private-node-label', volumes: [1], muted: false };
  for (const [result, reason] of [
    [{ exitCode: 42, signal: 'SIGTERM', stdout: 'private-output' }, 'helper_exit'],
    [{ exitCode: 1, signal: 'SIGKILL', timedOut: true, stdout: '' }, 'helper_timeout'],
    [{ exitCode: 0, stdout: 'private-invalid-ack' }, 'helper_ack_invalid'],
  ]) {
    const diagnostics = [];
    const graph = createPipeWireFocusGraph({ execute: async () => result,
      onDiagnostic: event => diagnostics.push(event) });
    assert.equal(await graph.compareAndSet('10', stream, [0.2], false, true), false);
    assert.ok(diagnostics.some(event => event.component === 'helper' && event.operation === 'set' && event.reason === reason));
    if (reason === 'helper_exit') assert.equal(diagnostics[0].exitCode, 42);
    if (reason === 'helper_timeout') assert.equal(diagnostics[0].timeoutMs, 1800);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-|player|node-label/);
  }
});

test('the read-only diagnostics command retains safe failures after Voice cleanup and clears on session change', async () => {
  const callbacks = [];
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true } }),
    startAudioFocus(_settings, options) {
      callbacks.push(options.onDiagnostic);
      return { playing() {
        options.onDiagnostic?.({ component: 'client', operation: 'set', reason: 'ack_timeout', timeoutMs: 2500 });
        options.onDiagnostic?.({ component: 'client', operation: 'set', reason: 'ack_timeout', raw: 'private-stream' });
      }, idle() {}, async close() {
        options.onDiagnostic?.({ component: 'client', operation: 'close', reason: 'cleanup_failed' });
      } };
    } });
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'playback_state', id: 'answer', playing: true, outputEpoch: 1, playbackGeneration: 1 });
  await f.command('off');
  await new Promise(resolve => setImmediate(resolve));
  await f.command('ducking diagnostics');
  const notice = f.notices.at(-1)[0];
  assert.match(notice, /ack_timeout/);
  assert.match(notice, /cleanup_failed/);
  assert.doesNotMatch(notice, /private-stream|raw/);
  assert.equal(f.workers.length, 1);
  await f.event('session_start');
  callbacks[0]({ component: 'client', operation: 'set', reason: 'ack_timeout' });
  await f.command('ducking diagnostics');
  assert.match(f.notices.at(-1)[0], /\[\]/);
});

test('close without acknowledgement retains cleanup failure separately from initial success', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-close-diagnostic-'));
  const path = join(runtimeDir, 'focus-v1.sock');
  const server = createServer(socket => socket.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      if (request.op === 'close') socket.end();
      else socket.write(JSON.stringify({ v: 1, id: request.id, ok: true }) + '\n');
    }
  }));
  await new Promise(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  const log = createFocusDiagnosticLog();
  const client = startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
    onDiagnostic: event => log.record(event), spawn: () => assert.fail('Mock socket already exists') });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve));
    await rm(runtimeDir, { recursive: true, force: true }); });
  client.playing('one');
  await waitFor(() => log.snapshot().some(event => event.operation === 'set' && event.reason === 'acknowledged'));
  await client.close();
  assert.ok(log.snapshot().some(event => event.operation === 'close' && event.reason === 'cleanup_failed'));
});

test('connection timeout is distinct from request acknowledgement timeout', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-focus-connect-diagnostic-'));
  const path = join(runtimeDir, 'focus-v1.sock');
  const server = createServer();
  await new Promise(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  const diagnostics = [];
  const client = startAudioFocus(settings, { runtimeDir, env: {}, filesystem: focusFileSystem,
    connect: () => new Socket(), onDiagnostic: event => diagnostics.push(event),
    spawn: () => assert.fail('A timeout must not spawn a competing broker') });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve));
    await rm(runtimeDir, { recursive: true, force: true }); });
  client.playing('one');
  await waitFor(() => diagnostics.some(event => event.reason === 'connect_timeout'));
  assert.equal(diagnostics.find(event => event.reason === 'connect_timeout').timeoutMs, 400);
  assert.equal(diagnostics.some(event => event.reason === 'ack_timeout'), false);
});

test('actual subprocess exit metadata is preserved without retaining stdout or stderr', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-focus-exit-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'dummy-control');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('private-output');\nprocess.stderr.write('private-stderr');\nprocess.exit(42);\n`, { mode: 0o700 });
  const log = createFocusDiagnosticLog();
  const graph = createPipeWireFocusGraph({ controlPath: executable, onDiagnostic: event => log.record(event) });
  assert.equal(await graph.compareAndSet('10', { id: 1, serial: '2', appId: 'player', binary: 'player',
    name: 'private-node', role: 'Music', volumes: [1], muted: false }, [0.2], false, true), false);
  const failure = log.snapshot().find(event => event.reason === 'helper_exit');
  assert.equal(failure.exitCode, 42);
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private-|dummy-control|paj-focus-exit/);
});

test('a blocked diagnostic IPC consumer cannot create an unbounded send backlog', () => {
  const sent = [];
  const completions = [];
  const send = createFocusDiagnosticSender((event, done) => { sent.push(event); completions.push(done); });
  for (let index = 0; index < 100; index++) {
    send({ component: 'broker', operation: 'startup', reason: 'startup_failed', elapsedMs: index });
  }
  assert.equal(sent.length, 1);
  while (completions.length) completions.shift()();
  assert.equal(sent.length, 9);
  assert.equal(sent.at(-1).elapsedMs, 8);
  const broken = createFocusDiagnosticSender(() => { throw new Error('private-channel-detail'); });
  assert.doesNotThrow(() => broken({ component: 'broker', operation: 'cleanup', reason: 'cleanup_failed' }));
});

test('the actual broker entrypoint sends a sanitized startup failure before its environment gate exits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-focus-entrypoint-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/audio-focus-broker.ts', import.meta.url))], {
    env: { HOME: directory }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const diagnostics = [];
  child.on('message', message => { if (message.type === 'paj-voice-focus-diagnostic') diagnostics.push(message.event); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true }); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Blocked broker did not exit')); }, 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 1);
  assert.ok(diagnostics.some(event => event.component === 'broker' && event.operation === 'environment' &&
    event.reason === 'environment_rejected'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /paj-focus-entrypoint|HOME/);
});

test('focus environment rejection retains a safe reason without socket or helper IO', async t => {
  const diagnostics = [];
  const forbidden = () => assert.fail('Rejected environment performed IO');
  const client = startAudioFocus(settings, { env: { PIPEWIRE_REMOTE: 'private-sensitive-target' },
    connect: forbidden, spawn: forbidden, filesystem: { lstat: forbidden },
    onDiagnostic: event => diagnostics.push(event) });
  t.after(() => client.close());
  client.playing('private-playback-token');
  await client.close();
  assert.ok(diagnostics.some(event => event.component === 'client' &&
    event.operation === 'environment' && event.reason === 'environment_rejected'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-sensitive-target|private-playback-token/);
});
