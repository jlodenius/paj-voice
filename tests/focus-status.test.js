import test from 'node:test';
import assert from 'node:assert/strict';
import { startAudioFocus } from '../src/audio-focus-client.ts';
import { createFocusDiagnosticLog } from '../src/audio-focus-diagnostics.ts';
import { EventEmitter } from 'node:events';
import { fixture } from './fixtures/extension.js';

const settings = { mode: 'duck-all', gain: 0.2, apps: [], excludeApps: [] };
const forbidden = () => assert.fail('Read-only focus status performed IO');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function protocol(overrides = {}) {
  const socket = new EventEmitter();
  const calls = [];
  socket.destroyed = false;
  socket.writableLength = 0;
  socket.destroy = () => { calls.push('destroy'); socket.destroyed = true; };
  socket.end = () => { calls.push('end'); };
  socket.write = frame => {
    const request = JSON.parse(frame);
    calls.push(request.op);
    queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ v: 1, id: request.id, ok: true }) + '\n')));
  };
  const options = { env: {}, runtimeDir: '/fake', spawn: forbidden,
    filesystem: { async lstat(path) {
      calls.push('lstat');
      return { uid: path === '/' ? 0 : process.getuid(), mode: path.endsWith('.sock') ? 0o600 : 0o700,
        isDirectory: () => true, isSymbolicLink: () => false, isSocket: () => true };
    } },
    connect() { calls.push('connect'); queueMicrotask(() => socket.emit('connect')); return socket; },
    ...overrides };
  return { socket, calls, client: startAudioFocus(settings, options) };
}

test('strict fake protocol reports connection, local intent, normal idle and close without terminal failure', async () => {
  const p = protocol();
  assert.deepEqual(p.client.snapshot(), { state: 'idle', leasePresent: false, terminal: null });
  p.client.playing('private-token');
  assert.deepEqual(p.client.snapshot(), { state: 'connecting', leasePresent: true, terminal: null });
  await settle();
  assert.equal(p.client.snapshot().state, 'connected');
  const before = [...p.calls];
  for (let i = 0; i < 100; i++) p.client.snapshot();
  assert.deepEqual(p.calls, before);
  p.client.idle('private-token');
  assert.deepEqual(p.client.snapshot(), { state: 'idle', leasePresent: false, terminal: null });
  await p.client.close();
  assert.deepEqual(p.client.snapshot(), { state: 'closed', leasePresent: false, terminal: null });
});

test('closing is distinct from completed local close and failed cleanup is retained without claiming restoration', async () => {
  const p = protocol();
  p.client.playing('one'); await settle();
  p.socket.write = frame => { p.calls.push(JSON.parse(frame).op); };
  const closing = p.client.close();
  assert.equal(p.client.snapshot().state, 'closing');
  assert.equal(p.client.snapshot().terminal, null);
  p.socket.emit('error', Object.assign(new Error('private-close'), { code: 'EPERM' }));
  await closing;
  assert.equal(p.client.snapshot().state, 'closed');
  assert.equal(p.client.snapshot().terminal.reason, 'cleanup_failed');
});

test('terminal socket failure is correlated, not an earlier success or unrelated helper diagnostic', async () => {
  const p = protocol();
  p.client.playing('private-token');
  await settle();
  p.socket.emit('data', Buffer.from(JSON.stringify({ v: 1, warning: '[focus-diagnostic] ' + JSON.stringify({
    component: 'helper', operation: 'set', reason: 'helper_exit', exitCode: 42 }) }) + '\n'));
  p.socket.emit('error', Object.assign(new Error('private-path'), { code: 'EACCES' }));
  assert.equal(p.client.snapshot().terminal.reason, 'socket_error');
  assert.equal(p.client.snapshot().terminal.code, 'EACCES');
  const before = [...p.calls];
  p.client.playing('ignored');
  p.client.snapshot();
  assert.deepEqual(p.calls, before);
  await p.client.close();
});

test('runtime and write failures retain only their directly correlated safe origin', async () => {
  const runtime = protocol({ filesystem: { async lstat() { throw Object.assign(new Error('private-path'), { code: 'EACCES' }); } } });
  runtime.client.playing('one');
  await settle();
  assert.equal(runtime.client.snapshot().terminal.reason, 'runtime_rejected');
  assert.equal(runtime.client.snapshot().terminal.code, 'EACCES');
  await runtime.client.close();
  const write = protocol();
  write.socket.write = () => { throw Object.assign(new Error('private-path'), { code: 'EPERM' }); };
  write.client.playing('two');
  await settle();
  assert.equal(write.client.snapshot().terminal.reason, 'request_failed');
  assert.equal(write.client.snapshot().terminal.code, 'EPERM');
  await write.client.close();
});

test('recoverable missing socket is never misattributed to an unrelated startup failure', async () => {
  const p = protocol({ connect() { throw Object.assign(new Error('private-missing'), { code: 'ENOENT' }); },
    spawn() { throw 'private-unstructured'; } });
  p.client.playing('one');
  await settle();
  assert.notEqual(p.client.snapshot().terminal?.code, 'ENOENT');
  assert.ok(['spawn_failed', 'unknown'].includes(p.client.snapshot().terminal.reason));
  assert.doesNotMatch(JSON.stringify(p.client.snapshot()), /private/);
  await p.client.close();
});

function readStatus(f) {
  return JSON.parse(f.notices.at(-1)[0].split('Background audio focus status: ')[1].split('\n')[0]);
}

test('extension reads distinguish absent, gated and unavailable clients without dependency calls', async t => {
  let reads = 0, constructs = 0, plays = 0;
  const f = fixture({ loadConfig() { reads++; return { backgroundAudio: { enabled: true, gain: 0.3 } }; },
    loadRoutes() { reads++; return undefined; },
    startAudioFocus() { constructs++; return { playing() { plays++; }, idle() {}, async close() {} }; } });
  t.after(() => f.command('off'));
  await f.command('ducking diagnostics');
  assert.deepEqual(readStatus(f), { armedPolicy: null,
    client: { state: 'not_created', leasePresent: false, terminal: null },
    trace: { observed: 0, acceptedPlaying: 0, playingCalls: 0, lastSkip: null } });
  assert.equal(reads, 0);
  await f.command('status');
  assert.equal(reads, 0);
  await f.command('on'); f.audio({ type: 'ready' });
  const baseline = reads;
  f.audio({ type: 'playback_state', playing: true });
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).client.state, 'not_created');
  assert.equal(readStatus(f).trace.lastSkip, 'invalid_frame');
  const frame = { type: 'playback_state', playing: true, id: 'private-id', outputEpoch: 1, playbackGeneration: 1 };
  f.audio(frame); f.audio(frame);
  await f.command('status');
  const snapshot = readStatus(f);
  assert.deepEqual(snapshot.armedPolicy, { enabled: true, gain: 0.3 });
  assert.equal(snapshot.client.state, 'unavailable');
  assert.deepEqual(snapshot.trace, { observed: 3, acceptedPlaying: 1, playingCalls: 1, lastSkip: 'version_duplicate' });
  assert.equal(constructs, 1); assert.equal(plays, 1); assert.equal(reads, baseline);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-id/);
  await f.command('off');
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).armedPolicy, null);
  assert.equal(readStatus(f).client.state, 'not_created');
  assert.equal(readStatus(f).trace.playingCalls, 1);
});

test('failed extension status is observational and session fences discard old callbacks', async t => {
  let dependencies = 0, callbacks;
  const f = fixture({ env: { PIPEWIRE_REMOTE: 'private-remote' },
    loadConfig() { dependencies++; return { backgroundAudio: { enabled: true } }; },
    loadRoutes() { dependencies++; return undefined; },
    startAudioFocus(policy, options) { callbacks = options; dependencies++;
      return startAudioFocus(policy, { ...options, connect: forbidden, spawn: forbidden,
        filesystem: { lstat: forbidden } }); } });
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  const worker = f.workers[0];
  f.audio({ type: 'playback_state', playing: true, id: 'private-frame', outputEpoch: 1, playbackGeneration: 1 });
  const baseline = dependencies;
  const warnings = f.notices.filter(([, level]) => level === 'warning').length;
  for (const command of ['ducking diagnostics', 'status', 'ducking diagnostics']) {
    await f.command(command);
    const status = readStatus(f);
    assert.equal(status.client.state, 'failed');
    assert.equal(status.client.terminal.reason, 'environment_rejected');
    assert.deepEqual(status.armedPolicy, { enabled: true, gain: 0.2 });
  }
  assert.equal(dependencies, baseline);
  assert.equal(f.notices.filter(([, level]) => level === 'warning').length, warnings);
  await f.event('session_start');
  const after = f.notices.length;
  callbacks.onWarning('private-late-warning');
  callbacks.onDiagnostic({ component: 'client', operation: 'set', reason: 'ack_timeout' });
  worker.args.onEvent({ type: 'playback_state', playing: true, id: 'late', outputEpoch: 2, playbackGeneration: 2 }, worker.args.generation);
  assert.equal(f.notices.length, after);
  await f.command('ducking diagnostics');
  assert.deepEqual(readStatus(f).trace, { observed: 0, acceptedPlaying: 0, playingCalls: 0, lastSkip: null });
  assert.equal(readStatus(f).client.state, 'not_created');
  assert.match(f.notices.at(-1)[0], /diagnostics \(read-only\): \[\]/);
});

test('all three extension counters saturate, normal idle is not a skip, defaults come only from arming', async t => {
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true } }),
    startAudioFocus: () => ({ playing() {}, idle() {}, async close() {} }) });
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  for (let i = 0; i < 1_000_005; i++) f.audio({ type: 'playback_state', playing: true,
    id: 'private', outputEpoch: 1, playbackGeneration: i });
  f.audio({ type: 'playback_state', playing: false, id: 'private', outputEpoch: 1, playbackGeneration: 1_000_004 });
  await f.command('ducking diagnostics');
  assert.deepEqual(readStatus(f).trace, { observed: 1_000_000, acceptedPlaying: 1_000_000,
    playingCalls: 1_000_000, lastSkip: null });
  const defaults = fixture({ startAudioFocus: forbidden });
  await defaults.command('ducking diagnostics');
  assert.equal(readStatus(defaults).armedPolicy, null);
  await defaults.command('on'); defaults.audio({ type: 'ready' });
  defaults.audio({ type: 'playback_state', playing: true, id: 'default', outputEpoch: 1, playbackGeneration: 1 });
  await defaults.command('ducking diagnostics');
  assert.deepEqual(readStatus(defaults).armedPolicy, { enabled: false, gain: 0.2 });
  assert.equal(readStatus(defaults).trace.lastSkip, 'policy_off');
  await defaults.command('off');
});

test('generation, output and construction/dispatch gates keep distinct bounded decisions', async t => {
  let throwConstruction = true;
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true } }),
    startAudioFocus() {
      if (throwConstruction) throw Error('private-construction');
      return { playing() { throw Error('private-dispatch'); }, idle() {}, async close() {} };
    } });
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  const worker = f.workers[0];
  const frame = { type: 'playback_state', playing: true, id: 'one', outputEpoch: 1, playbackGeneration: 1 };
  worker.args.onEvent(frame, 'wrong-generation');
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).trace.lastSkip, 'generation');
  f.audio({ type: 'availability', input: true, output: false }); f.audio(frame);
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).trace.lastSkip, 'inactive_output_unavailable');
  assert.equal(readStatus(f).trace.acceptedPlaying, 0);
  f.audio({ type: 'availability', input: true, output: true }); f.audio(frame);
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).trace.lastSkip, 'construction_dispatch_error');
  assert.equal(readStatus(f).trace.acceptedPlaying, 1);
  assert.equal(readStatus(f).trace.playingCalls, 0);
  assert.equal(readStatus(f).client.state, 'not_created');
  throwConstruction = false;
  f.audio({ ...frame, playbackGeneration: 2 });
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).trace.acceptedPlaying, 2);
  assert.equal(readStatus(f).trace.playingCalls, 1);
  assert.equal(readStatus(f).client.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(readStatus(f)), /private/);
});

test('current cleanup warnings survive off, but retired warning callbacks stay fenced', async () => {
  let warn;
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true } }),
    startAudioFocus(_policy, options) { warn = options.onWarning;
      return { playing() {}, idle() {}, async close() { options.onWarning('Cleanup remains unconfirmed'); } }; } });
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'playback_state', playing: true, id: 'one', outputEpoch: 1, playbackGeneration: 1 });
  await f.command('off'); await settle();
  assert.ok(f.notices.some(([message]) => message === 'Cleanup remains unconfirmed'));
  const before = f.notices.length;
  warn('private-retired-warning');
  assert.equal(f.notices.length, before);
});

test('unknown or unsafe external snapshots never invent a healthy existing client', async t => {
  let value = { state: 'connected', leasePresent: true, terminal: null };
  const f = fixture({ loadConfig: () => ({ backgroundAudio: { enabled: true } }),
    startAudioFocus: () => ({ playing() {}, idle() {}, async close() {}, snapshot: () => value }) });
  t.after(() => f.command('off'));
  await f.command('on'); f.audio({ type: 'ready' });
  f.audio({ type: 'playback_state', playing: true, id: 'one', outputEpoch: 1, playbackGeneration: 1 });
  await f.command('ducking diagnostics');
  assert.equal(readStatus(f).client.state, 'connected');
  for (value of [undefined, { state: 'private-name', leasePresent: true, terminal: null },
    { state: 'failed', leasePresent: true, terminal: { reason: 'private-path', ageMs: 0 } },
    { state: 'failed', leasePresent: true, terminal: { reason: 'unknown', ageMs: Infinity } }]) {
    await f.command('ducking diagnostics');
    assert.equal(readStatus(f).client.state, 'unavailable');
    assert.doesNotMatch(JSON.stringify(readStatus(f)), /private/);
  }
});

test('terminal environment failure outlives history without retry or status IO', async () => {
  let now = 0;
  const history = createFocusDiagnosticLog(() => now);
  const warnings = [];
  const client = startAudioFocus(settings, { env: { PIPEWIRE_REMOTE: 'private-remote' },
    now: () => now, connect: forbidden, spawn: forbidden, filesystem: { lstat: forbidden },
    onDiagnostic: event => history.record(event), onWarning: message => warnings.push(message) });
  assert.equal(client.snapshot().state, 'idle');
  client.playing('private-token');
  assert.equal(client.snapshot().state, 'failed');
  assert.deepEqual(client.snapshot().terminal, { component: 'client', operation: 'environment',
    reason: 'environment_rejected', ageMs: 0 });
  now = 900001;
  assert.deepEqual(history.snapshot(), []);
  const snapshot = client.snapshot();
  assert.equal(snapshot.terminal.ageMs, 900001);
  snapshot.terminal.reason = 'private-error';
  client.playing('ignored');
  assert.equal(client.snapshot().terminal.reason, 'environment_rejected');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(client.snapshot()), /private/);
  now = Number.MAX_SAFE_INTEGER;
  assert.equal(client.snapshot().terminal.ageMs, 2147483647);
  now = -10;
  assert.equal(client.snapshot().terminal.ageMs, 0);
  now = NaN;
  assert.equal(client.snapshot().terminal.ageMs, 0);
  await client.close();
  assert.equal(client.snapshot().state, 'closed');
  assert.equal(client.snapshot().terminal.reason, 'environment_rejected');
});
