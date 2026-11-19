import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvailabilityDiagnosticLog, safeAvailabilityDiagnostic } from '../src/availability-diagnostics.ts';
import { fixture } from './fixtures/extension.js';

const dto = (changes = {}) => ({ type: 'availability_diagnostic', v: 1,
  reason: 'capture_stall', inputPresent: true, outputPresent: true,
  inputChanged: false, outputChanged: false, pcmAgeMs: 2000, recoveryCount: 0, ...changes });

const snapshot = async f => {
  await f.command('availability diagnostics');
  const text = f.notices.at(-1)[0];
  assert.match(text, /^Availability diagnostics \(read-only\): /);
  return JSON.parse(text.slice(text.indexOf(': ') + 2));
};

test('production commands observe native DTOs without changing behavior, and retain historical diagnostics after off', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  f.pi.exec = async () => assert.fail('No real enumeration or helpers');
  assert.equal((await snapshot(f)).state, 'not_observed');
  await f.command('on');
  f.audio({ type: 'ready' });
  const before = f.controller.state();
  const frameCount = f.frames.length;
  f.audio(dto());
  assert.deepEqual(f.controller.state(), before);
  assert.equal(f.frames.length, frameCount);
  let result = await snapshot(f);
  assert.equal(result.state, 'observed');
  assert.equal(result.latest.reason, 'capture_stall');
  assert.equal(result.currentCount, 1);
  assert.equal(result.latest.currentConnection, true);
  await f.command('off');
  result = await snapshot(f);
  assert.equal(result.retainedCount, 1);
  assert.equal(result.currentCount, 0);
  assert.equal(result.connection, 'inactive');
  assert.equal(result.latest.currentConnection, false);
  await f.command('status');
  assert.match(f.notices.at(-1)[0], /Availability diagnostics: .*"retainedCount":1/);
});

test('capture faults use neutral availability warnings and model context, not claims of physical removal', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  f.audio({ type: 'availability', input: false, output: true });
  assert.ok(f.notices.some(([text]) => text === 'Microphone capture is temporarily unavailable. Playback remains available. Unfinished speech was not sent.'));
  const context = await f.event('context', { messages: [] });
  assert.match(context.messages.at(-1).content, /capture may be unavailable even when the selected endpoint resolves/i);
  assert.doesNotMatch(context.messages.at(-1).content, /until that same endpoint returns/);
  f.audio({ type: 'availability', input: false, output: false });
  assert.ok(f.notices.some(([text]) => text === 'Microphone capture and playback are temporarily unavailable. Unfinished speech was not sent.'));
});

test('production diagnostics distinguish output transport health from target resolution', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  const before = f.controller.state();
  f.audio(dto({ reason: 'output_health_failed', inputPresent: null, outputPresent: null,
    inputChanged: null, outputChanged: null, pcmAgeMs: null }));
  const result = await snapshot(f);
  assert.equal(result.state, 'observed');
  assert.equal(result.latest.reason, 'output_health_failed');
  assert.deepEqual(f.controller.state(), before);
});

test('closed diagnostic DTOs are copied without retaining caller-owned objects', () => {
  const value = dto();
  const safe = safeAvailabilityDiagnostic(value);
  assert.deepEqual(safe, value);
  assert.notEqual(safe, value);
  value.reason = 'private raw error';
  assert.equal(safe.reason, 'capture_stall');
});

test('validator rejects unknown keys, unknown reasons, missing fields, bags and every invalid primitive/range', () => {
  const invalid = [null, false, 1, 'private', [], { ...dto(), rawError: 'private-marker' },
    { ...dto(), type: 'diagnostic' }, { ...dto(), v: 2 }, { ...dto(), reason: 'private-marker' },
    { ...dto(), [Symbol('private-marker')]: true }, { ...dto(), reason: '__proto__' },
    { ...dto(), reason: 'graph_query_failed' },
    Object.assign(Object.create({ rawError: 'private-marker' }), dto())];
  for (const key of Object.keys(dto())) {
    const missing = dto();
    delete missing[key];
    invalid.push(missing);
  }
  for (const key of ['inputPresent', 'outputPresent', 'inputChanged', 'outputChanged']) {
    for (const value of [undefined, 0, 1, 'true', {}, []]) invalid.push(dto({ [key]: value }));
  }
  for (const value of [undefined, -1, 60001, 0.5, NaN, Infinity, '1', false, {}, [], 1n]) {
    invalid.push(dto({ pcmAgeMs: value }));
  }
  for (const value of [undefined, null, -1, 2147483648, 0.5, NaN, Infinity, '1', false, {}, []]) {
    invalid.push(dto({ recoveryCount: value }));
  }
  let invoked = false;
  const accessor = dto();
  Object.defineProperty(accessor, 'reason', { get() { invoked = true; throw new Error('private-marker'); } });
  invalid.push(accessor, new Proxy({}, { ownKeys() { throw new Error('private-marker'); } }));
  for (const value of invalid) assert.equal(safeAvailabilityDiagnostic(value), undefined);
  assert.equal(invoked, false);
  for (const reason of ['graph_query_failed', 'source_unresolved', 'source_changed', 'target_unresolved',
    'target_changed', 'capture_eof', 'capture_stall', 'capture_stale_queue', 'capture_overflow',
    'capture_discontinuity', 'capture_process_exit', 'capture_dc_corruption', 'capture_processing_failed',
    'capture_health_failed', 'input_warmup_timeout', 'input_recovered', 'output_recovered']) {
    const value = dto({ reason, inputPresent: null, outputPresent: null,
      inputChanged: null, outputChanged: null, pcmAgeMs: null, recoveryCount: 2147483647 });
    assert.deepEqual(safeAvailabilityDiagnostic(value), value);
  }
  for (const pcmAgeMs of [0, 60000]) assert.equal(safeAvailabilityDiagnostic(dto({ pcmAgeMs })).pcmAgeMs, pcmAgeMs);
});

test('malformed native diagnostics never enter status, UI, messages, logs or controller behavior', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  const before = f.controller.state();
  for (const value of [dto({ rawError: 'private-marker' }), dto({ reason: 'private-marker' }),
    dto({ pcmAgeMs: 'private-marker' }), dto({ inputPresent: { node: 'private-marker' } }),
    dto({ v: 999 }), { type: 'availability_diagnostic' }]) f.audio(value);
  assert.deepEqual(f.controller.state(), before);
  assert.equal((await snapshot(f)).retainedCount, 0);
  assert.doesNotMatch(JSON.stringify([f.notices, f.widgets.map(widget => widget.lines), f.messages]), /private-marker/);
});

test('diagnostics and status are pure memory reads with every external dependency forbidden', async () => {
  const forbidden = () => assert.fail('Read-only diagnostics invoked an external dependency');
  const f = fixture({ loadConfig: forbidden, loadDevices: forbidden, loadRoutes: forbidden,
    startCompanion: forbidden, startAudioFocus: forbidden, previewBackgroundAudio: forbidden,
    saveDevices: forbidden, saveRoute: forbidden, saveFallback: forbidden,
    saveRouteBinding: forbidden, updateRouteProtection: forbidden });
  f.pi.exec = forbidden;
  f.pi.sendUserMessage = forbidden;
  await f.command('availability diagnostics');
  await f.command('status');
  await f.command('availability anything-else');
  assert.equal(f.frames.length, 0);
  assert.equal(f.workers.length, 0);
  assert.equal(f.controller.state().enabled, false);
  assert.doesNotMatch(f.notices.map(([text]) => text).join('\n'), /healthy/);
});

test('retired generations, connections and session boundaries cannot update or mislabel observations', async t => {
  const f = fixture();
  t.after(() => f.command('off'));
  await f.command('on');
  f.audio({ type: 'ready' });
  const old = f.workers[0];
  f.audio(dto({ reason: 'input_recovered', recoveryCount: 1 }));
  await f.command('off');
  old.args.onEvent(dto(), old.args.generation);
  assert.equal((await snapshot(f)).retainedCount, 1);
  await f.command('on');
  f.audio({ type: 'ready' });
  assert.equal((await snapshot(f)).state, 'not_observed');
  assert.equal((await snapshot(f)).latest.currentConnection, false);
  const current = f.workers.at(-1);
  current.args.onEvent(dto(), old.args.generation);
  assert.equal((await snapshot(f)).retainedCount, 1);
  f.audio(dto());
  assert.equal((await snapshot(f)).currentCount, 1);
  for (const event of ['session_tree', 'session_start', 'session_shutdown']) {
    if (event !== 'session_tree') {
      await f.command('on');
      f.audio({ type: 'ready' });
      f.audio(dto());
    }
    await f.event(event);
    current.args.onEvent(dto(), current.args.generation);
    assert.equal((await snapshot(f)).retainedCount, 0);
  }
});

test('same-generation route handoffs fence retired native connections and mark old recovery evidence historical', async t => {
  const desk = { input: 'synthetic-input-a', output: 'synthetic-output-a' };
  const other = { input: 'synthetic-input-b', output: 'synthetic-output-b' };
  const saved = { version: 2, active: 'desk', routes: { desk, other } };
  const f = fixture({ loadRoutes: () => structuredClone(saved),
    loadDevices: () => ({ version: 1, ...saved.routes[saved.active] }),
    saveRoute: (_file, name) => { saved.active = name; } });
  t.after(() => f.command('off'));
  f.pi.exec = async (_executable, args) => {
    assert.deepEqual(args, ['--devices']);
    return { code: 0, stdout: JSON.stringify([desk, other].flatMap(route => [
      { name: route.input, class: 'Audio/Source' }, { name: route.output, class: 'Audio/Sink' },
    ])) };
  };
  await f.command('on');
  f.audio({ type: 'ready' });
  f.audio(dto({ reason: 'input_recovered', recoveryCount: 1 }));
  const old = f.workers[0];
  const switching = f.command('route other');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[1].args.generation, old.args.generation);
  old.args.onEvent(dto({ reason: 'output_recovered', recoveryCount: 2 }), old.args.generation);
  let result = await snapshot(f);
  assert.equal(result.retainedCount, 1);
  assert.equal(result.currentCount, 0);
  assert.equal(result.latest.currentConnection, false);
  f.audio(dto({ reason: 'graph_query_failed', inputPresent: null, outputPresent: null,
    inputChanged: null, outputChanged: null, pcmAgeMs: null }));
  result = await snapshot(f);
  assert.equal(result.latest.reason, 'graph_query_failed');
  assert.equal(result.currentCount, 1);
  f.audio({ type: 'ready' });
  await switching;
  f.replace();
  f.audio(dto({ reason: 'input_recovered' }));
  result = await snapshot(f);
  assert.equal(result.retainedCount, 2);
  assert.equal(result.currentCount, 0);
});

test('compiled production registerVoice validates native DTOs and exposes memory-only diagnostics', async t => {
  const { registerVoice } = await import('../dist/extension.js');
  const f = fixture({}, registerVoice);
  t.after(() => f.command('off'));
  f.pi.exec = async () => assert.fail('Compiled diagnostics must not spawn helpers');
  await f.command('on');
  f.audio({ type: 'ready' });
  f.audio(dto({ reason: 'capture_dc_corruption', recoveryCount: 2147483647, pcmAgeMs: null }));
  f.audio(dto({ error: 'private-marker' }));
  assert.equal((await snapshot(f)).retainedCount, 1);
  await f.command('status');
  assert.match(f.notices.at(-1)[0], /Availability diagnostics: .*capture_dc_corruption/);
  assert.doesNotMatch(f.notices.at(-1)[0], /private-marker/);
});

test('memory snapshots are bounded to 32 events and 15 minutes, with timestamps, ages and connection scope', () => {
  let now = 0;
  const log = createAvailabilityDiagnosticLog(() => now, () => 1_700_000_000_000 + now);
  const first = {}, second = {};
  assert.equal(log.snapshot(first).state, 'not_observed');
  for (let i = 0; i < 40; i++) {
    log.record(dto({ recoveryCount: i }), first);
    now += 10;
  }
  let snapshot = log.snapshot(first);
  assert.equal(snapshot.retainedCount, 32);
  assert.equal(snapshot.currentCount, 32);
  assert.equal(snapshot.counts.capture_stall, 32);
  assert.equal(snapshot.latest.recordedAtMs, 1_700_000_000_390);
  assert.equal(snapshot.latest.ageMs, 10);
  assert.equal(snapshot.latest.recoveryCount, 39);
  assert.equal(log.snapshot(second).state, 'not_observed');
  assert.equal(log.snapshot().connection, 'inactive');
  assert.equal(log.snapshot().currentCount, 0);
  snapshot.entries[0].reason = 'private mutation';
  assert.equal(log.snapshot(first).entries[0].reason, 'capture_stall');
  now = 900_390;
  assert.equal(log.snapshot(first).retainedCount, 0);
  assert.equal(log.snapshot(first).state, 'not_observed');
  log.record(dto(), second);
  log.clear();
  assert.equal(log.snapshot(second).retainedCount, 0);
});
