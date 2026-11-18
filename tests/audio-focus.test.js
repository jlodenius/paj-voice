import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioFocus } from '../src/audio-focus.ts';

const settings = (gain = 0.25, apps = ['music'], excludeApps = []) =>
  ({ mode: 'duck', gain, apps, excludeApps });
const stream = (overrides = {}) => ({ serial: '1', id: 10, appId: 'org.music',
  binary: 'music', role: 'Music', name: 'output', volumes: [0.8, 0.4], muted: false,
  ...overrides });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const eventually = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  assert.ok(predicate());
};
function graph(streams = [stream()]) {
  return {
    state: { generation: 'one', streams }, writes: [], operations: [], snapshots: 0,
    async snapshot() { this.snapshots++; return structuredClone(this.state); },
    async compareAndSet(generation, expected, volumes, restore = false) {
      const current = this.state.streams.find(s => s.serial === expected.serial);
      if (generation !== this.state.generation || JSON.stringify(current) !== JSON.stringify(expected)) {
        return false;
      }
      this.operations.push({ expected: structuredClone(expected), restore });
      this.writes.push([...volumes]);
      current.volumes = [...volumes];
      return true;
    },
  };
}

test('one baseline preserves balance across overlapping owners and restores on close', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 1000, releaseMs: 0 });
  await focus.set('a', settings());
  assert.deepEqual(g.state.streams[0].volumes, [0.2, 0.1]);
  await focus.set('b', settings(0.5));
  await focus.set('a', null);
  assert.deepEqual(g.state.streams[0].volumes, [0.4, 0.2]);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
});

test('float32 and rounded readbacks retain acknowledged ownership and restore the baseline', async () => {
  for (const round of [Math.fround, value => Number(value.toFixed(6))]) {
    const original = [0.81234567, 0.43216543];
    const g = graph([stream({ volumes: original })]);
    const cas = g.compareAndSet.bind(g);
    g.compareAndSet = async (...args) => {
      const acknowledged = await cas(...args);
      if (acknowledged) g.state.streams[0].volumes = args[2].map(round);
      return acknowledged;
    };
    const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 0 });
    await focus.set('a', settings(0.2));
    await delay(20);
    await focus.set('a', null);
    await focus.close();
    assert.equal(g.writes.length, 2);
    assert.deepEqual(g.writes[1], original);
    assert.deepEqual(g.state.streams[0].volumes, original.map(round));
  }
});

test('external edits are respected for the entire ownership cycle and generations fence restore', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 0 });
  await focus.set('a', settings());
  g.state.streams[0].volumes = [0.7, 0.3];
  await delay(25);
  await focus.set('b', settings(0.1));
  assert.deepEqual(g.state.streams[0].volumes, [0.7, 0.3]);
  await focus.set('a', null);
  await focus.set('b', null);
  await focus.set('c', settings());
  assert.deepEqual(g.state.streams[0].volumes, [0.175, 0.075]);
  g.state.generation = 'two';
  g.state.streams = [stream({ volumes: [0.6, 0.2] })];
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.6, 0.2]);
});

test('a Core replacement fences every old lease until a fresh ownership cycle starts', async () => {
  const g = graph();
  const warnings = [];
  const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 0,
    onWarning: message => warnings.push(message) });
  await focus.set('a', settings());
  g.state = { generation: 'two', streams: [stream({ serial: '2', id: 20, volumes: [0.6, 0.2] })] };
  await focus.set('b', settings(0.1));
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  assert.deepEqual(g.state.streams[0].volumes, [0.6, 0.2]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /generation.*quiet.*manually/i);
  await focus.set('a', null, true);
  await focus.set('b', settings());
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  await focus.set('b', null, true);
  await focus.set('fresh', settings());
  assert.deepEqual(g.state.streams[0].volumes, [0.15, 0.05]);
  await focus.set('fresh', null, true);
  assert.deepEqual(g.state.streams[0].volumes, [0.6, 0.2]);
  await focus.close();
});

test('an active cycle pins its Core even when no stream was initially eligible', async () => {
  const g = graph([]);
  const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 0 });
  await focus.set('a', settings());
  g.state = { generation: 'two', streams: [stream()] };
  await focus.set('a', settings());
  assert.deepEqual(g.writes, []);
  await focus.set('a', null, true);
  await focus.set('fresh', settings());
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
});

test('a Core replacement during release debounce cannot replay a queued old-cycle lease', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 100 });
  await focus.set('a', settings());
  await focus.set('a', null);
  g.state = { generation: 'two', streams: [stream({ volumes: [0.6, 0.2] })] };
  await delay(20);
  await focus.set('queued', settings());
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  await focus.set('queued', null, true);
  await focus.set('fresh', settings());
  assert.deepEqual(g.state.streams[0].volumes, [0.15, 0.05]);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.6, 0.2]);
});

test('preview does not pin a Core generation before a fresh playing lease', async () => {
  const g = graph();
  const focus = createAudioFocus(g);
  await focus.preview(settings());
  g.state = { generation: 'two', streams: [stream({ volumes: [0.6, 0.2] })] };
  await focus.set('fresh', settings());
  assert.deepEqual(g.state.streams[0].volumes, [0.15, 0.05]);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.6, 0.2]);
});

test('concurrent updates coalesce and preview stays read-only while an owner is active', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 1000 });
  const selected = settings();
  const pending = Array.from({ length: 32 }, (_, i) => focus.set(String(i), selected));
  selected.apps[0] = 'not-music';
  await Promise.all(pending);
  assert.equal(g.snapshots, 1);
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  const before = structuredClone(g.writes);
  assert.deepEqual(await focus.preview(settings(0.05)),
    { available: ['org.music'], eligible: ['org.music'], excluded: 0, unsupported: 0 });
  assert.deepEqual(g.writes, before);
  await focus.close();
});

test('muting restores the owned baseline without changing mute or re-ducking after unmute', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5 });
  await focus.set('a', settings());
  g.state.streams[0].muted = true;
  await delay(20);
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
  assert.equal(g.state.streams[0].muted, true);
  assert.equal(g.operations[1].restore, true);
  assert.equal(g.operations[1].expected.muted, true);
  g.state.streams[0].muted = false;
  await focus.set('b', settings(0.1));
  await focus.close();
  assert.deepEqual(g.writes, [[0.2, 0.1], [0.8, 0.4]]);
  assert.equal(g.state.streams[0].muted, false);
});

test('role, name and application transitions restore current-node baseline and tombstone the cycle', async () => {
  for (const change of [{ role: 'Communication' }, { name: 'new-context' },
    { appId: 'org.new-context' }, { binary: 'another-app' }]) {
    const g = graph();
    const focus = createAudioFocus(g, { pollMs: 5 });
    await focus.set('a', settings());
    Object.assign(g.state.streams[0], change);
    await eventually(() => g.state.streams[0].volumes[0] === 0.8);
    assert.equal(g.operations[0].restore, false);
    assert.equal(g.operations[1].restore, true);
    for (const [key, value] of Object.entries(change)) assert.equal(g.operations[1].expected[key], value);
    await focus.set('b', settings(0.1));
    await focus.close();
    assert.deepEqual(g.writes, [[0.2, 0.1], [0.8, 0.4]]);
  }
});

test('manual gain changes win over simultaneous role and mute transitions', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5 });
  await focus.set('a', settings());
  Object.assign(g.state.streams[0], { role: 'Communication', muted: true, volumes: [0.6, 0.3] });
  await delay(20);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.6, 0.3]);
  assert.equal(g.state.streams[0].muted, true);
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
});

test('all native protected roles are excluded without writes or routine warnings', async () => {
  const g = graph(['communication', 'PHONE', 'Alert', 'Emergency', 'Notification', 'Event',
    'Accessibility', 'Alarm', 'RINGTONE', 'Voice'].map((role, i) => stream({ role, serial: String(i) })));
  const warnings = [];
  const focus = createAudioFocus(g, { onWarning: message => warnings.push(message) });
  assert.deepEqual(await focus.preview(settings()), {
    available: [], eligible: [], excluded: 10, unsupported: 0,
  });
  await focus.set('a', settings());
  await focus.close();
  assert.deepEqual(g.writes, []);
  assert.deepEqual(warnings, []);
});

test('unconfirmed write acknowledgements warn once about possible low volume and manual recovery', async () => {
  const g = graph();
  const cas = g.compareAndSet.bind(g);
  g.compareAndSet = async (...args) => { await cas(...args); return false; };
  const warnings = [];
  const focus = createAudioFocus(g, { pollMs: 5, onWarning: message => warnings.push(message) });
  await focus.set('a', settings());
  await focus.set('b', settings(0.1));
  await delay(20);
  await focus.close();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /restoration is not confirmed/i);
  assert.match(warnings[0], /quiet.*application volume manually/i);
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
});

test('Voice identity is never written even when an owned stream changes into Voice', async () => {
  const g = graph();
  const warnings = [];
  const focus = createAudioFocus(g, { pollMs: 5, onWarning: message => warnings.push(message) });
  await focus.set('a', settings());
  g.state.streams[0].appId = 'org.paj.voice';
  await delay(20);
  await focus.close();
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /protected Voice.*manually/);
});

test('late acknowledged duck is restored when close races a pending write', async () => {
  const g = graph();
  const cas = g.compareAndSet.bind(g);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  g.compareAndSet = async (...args) => {
    if (!finish) {
      entered();
      await new Promise(resolve => { finish = resolve; });
    }
    return cas(...args);
  };
  const focus = createAudioFocus(g, { pollMs: 5 });
  const acquisition = focus.set('a', settings());
  await started;
  const closing = focus.close();
  finish();
  await Promise.all([acquisition, closing]);
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
  const count = g.snapshots;
  await delay(20);
  assert.equal(g.snapshots, count);
  await assert.rejects(focus.set('b', settings()), /closed/);
});

test('last-owner cancellation accounts for both successful and rejected late acknowledgements', async () => {
  for (const acknowledged of [true, false]) {
    const g = graph();
    const cas = g.compareAndSet.bind(g);
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    let resume;
    let initial = true;
    g.compareAndSet = async (...args) => {
      if (initial) {
        initial = false;
        enter();
        await new Promise(resolve => { resume = resolve; });
        if (!acknowledged) return false;
      }
      return cas(...args);
    };
    const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 0 });
    const setting = focus.set('a', settings());
    await entered;
    const cancelling = focus.set('a', null);
    resume();
    await Promise.all([setting, cancelling]);
    assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
    assert.equal(g.writes.length, acknowledged ? 2 : 0);
    await focus.close();
  }
});

test('external gain changes beyond rounding tolerance are not restored', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5 });
  await focus.set('a', settings());
  g.state.streams[0].volumes = [0.20001, 0.1];
  await delay(20);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.20001, 0.1]);
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
});

test('immediate owner release cancels a pending debounce and awaits the restore acknowledgement', async t => {
  const g = graph();
  const focus = createAudioFocus(g, { releaseMs: 200, pollMs: 5 });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  t.after(async () => { resume(); await focus.close(); });
  await focus.set('a', settings());
  await focus.set('a', null);
  const cas = g.compareAndSet.bind(g);
  let restoring = false;
  g.compareAndSet = async (...args) => {
    if (args[3]) { restoring = true; await gate; }
    return cas(...args);
  };
  let settled = false;
  const release = focus.set('a', null, true).then(() => { settled = true; });
  await delay(10);
  assert.equal(restoring, true);
  assert.equal(settled, false);
  assert.deepEqual(g.state.streams[0].volumes, [0.2, 0.1]);
  resume();
  await release;
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
});

test('immediate owner release preserves other active owners and their shared baseline', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { releaseMs: 200 });
  await focus.set('a', settings());
  await focus.set('b', settings(0.5));
  await focus.set('a', null, true);
  assert.deepEqual(g.state.streams[0].volumes, [0.4, 0.2]);
  assert.equal(g.operations.at(-1).restore, false);
  await focus.set('b', null, true);
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
  assert.equal(g.operations.at(-1).restore, true);
  await focus.close();
});

test('release debounce bridges queued gaps without multiplying or restoring between clips', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 35 });
  await focus.set('a', settings());
  await focus.set('a', null);
  await delay(10);
  assert.deepEqual(g.state.streams[0].volumes, [0.2, 0.1]);
  await focus.set('b', settings());
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
  await focus.set('b', null);
  await eventually(() => g.state.streams[0].volumes[0] === 0.8);
  await focus.close();
});

test('failed CAS relinquishes without restore or re-duck until all owners leave', async () => {
  const g = graph();
  const cas = g.compareAndSet.bind(g);
  let reject = false;
  g.compareAndSet = (...args) => reject ? Promise.resolve(false) : cas(...args);
  const focus = createAudioFocus(g, { pollMs: 5, releaseMs: 0 });
  await focus.set('a', settings());
  reject = true;
  await focus.set('b', settings(0.1));
  reject = false;
  await delay(20);
  await focus.set('b', null);
  assert.deepEqual(g.state.streams[0].volumes, [0.2, 0.1]);
  await focus.close();
  assert.deepEqual(g.state.streams[0].volumes, [0.2, 0.1]);
});

test('poll discovers new streams and never resurrects removed or identity-reused streams', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { pollMs: 5 });
  await focus.set('a', settings());
  g.state.streams.push(stream({ serial: '2', id: 20 }));
  await eventually(() => g.state.streams[1].volumes[0] === 0.2);
  g.state.streams[0] = stream({ appId: 'org.changed', volumes: [0.6, 0.3] });
  await delay(20);
  await focus.close();
  assert.deepEqual(g.state.streams.map(s => s.volumes), [[0.6, 0.3], [0.8, 0.4]]);
});

test('graph failure warns once, performs no stale replay and stops polling on close', async () => {
  const g = graph();
  const warnings = [];
  const focus = createAudioFocus(g, { pollMs: 5, onWarning: message => warnings.push(message) });
  await focus.set('a', settings());
  g.snapshot = async () => { throw new Error('gone'); };
  await delay(20);
  await focus.set('b', settings());
  await focus.close();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /graph failed.*quiet.*application volume manually/);
  assert.deepEqual(g.writes, [[0.2, 0.1]]);
});

test('off preview discovers safe stable selectors without selecting or writing any stream', async () => {
  const g = graph([
    stream(), stream({ serial: '2', appId: '', binary: 'browser', role: 'Unknown' }),
    stream({ serial: '3', appId: 'org.private', role: 'Phone' }),
    stream({ serial: '4', appId: 'org.muted', muted: true }),
    stream({ serial: '5', appId: '', binary: 'browser' }),
    stream({ serial: '6', appId: 'private title/url', binary: 'safe-binary' }),
  ]);
  const focus = createAudioFocus(g);
  assert.deepEqual(await focus.preview({}), {
    available: ['browser', 'org.music', 'safe-binary'], eligible: [], excluded: 6, unsupported: 0,
  });
  await focus.set('a', { mode: 'off' });
  assert.deepEqual(g.writes, []);
  await focus.close();
});

test('settings share configuration defaults, selector limits and explicit duck opt-in', async () => {
  const g = graph();
  const focus = createAudioFocus(g, { releaseMs: 0 });
  await focus.set('a', {});
  await focus.set('a', { mode: 'off', gain: 0.2, apps: [], excludeApps: [] });
  assert.deepEqual(g.writes, []);
  for (const bad of [settings(0.2, []), settings(0.2, ['with space']),
    settings(0.2, ['a'.repeat(129)]), settings(0.2, Array(33).fill('music')),
    settings(0.2, ['music'], ['bad/selector'])]) {
    await assert.rejects(focus.set('a', bad), /Invalid/);
    await assert.rejects(focus.preview(bad), /Invalid/);
  }
  await focus.set('a', { mode: 'duck', apps: ['music'] });
  assert.deepEqual(g.state.streams[0].volumes, [0.16000000000000003, 0.08000000000000002]);
  await focus.close();
});

test('invalid settings are rejected and finite stream, channel and owner bounds are enforced', async () => {
  const g = graph(Array.from({ length: 130 }, (_, i) => stream({ serial: String(i), id: i })));
  const focus = createAudioFocus(g, { pollMs: 1000 });
  for (const bad of [NaN, Infinity, 0.01, 1.1]) {
    await assert.rejects(focus.set('a', settings(bad)), /Invalid/);
  }
  await assert.rejects(focus.set('a', settings(0.25, ['bad\nselector'])), /Invalid/);
  const preview = await focus.preview(settings());
  assert.deepEqual(preview, { available: ['org.music'], eligible: ['org.music'], excluded: 0, unsupported: 2 });
  g.state.streams = [stream({ volumes: Array(65).fill(1) }), stream({ serial: '2', volumes: [4.1] })];
  assert.equal((await focus.preview(settings())).unsupported, 2);
  for (let i = 0; i < 32; i++) await focus.set(String(i), settings());
  await assert.rejects(focus.set('33', settings()), /Too many/);
  await focus.close();
});

test('preview is read-only, private, explicit and excludes protected or unsupported streams', async () => {
  const g = graph([
    stream(), stream({ serial: '2', role: 'communication' }),
    stream({ serial: '3', name: 'paj_voice_play-123' }),
    stream({ serial: '4', appId: 'org.paj.voice' }),
    stream({ serial: '5', muted: true }),
    stream({ serial: '6', volumes: [NaN] }),
    stream({ serial: '7', binary: 'other', appId: 'org.other', role: 'Unknown' }),
    stream({ serial: '8', binary: 'excluded', appId: 'org.excluded' }),
  ]);
  const focus = createAudioFocus(g);
  assert.deepEqual(await focus.preview(settings(0.25, ['music', 'org.excluded'], ['excluded'])),
    { available: ['org.excluded', 'org.music', 'org.other'], eligible: ['org.music'], excluded: 6, unsupported: 1 });
  assert.equal(g.writes.length, 0);
  assert.deepEqual((await focus.preview({ mode: 'off' })).eligible, []);
  await focus.set('a', settings());
  assert.deepEqual(g.state.streams[0].volumes, [0.2, 0.1]);
  assert.deepEqual(g.state.streams[1].volumes, [0.8, 0.4]);
  await focus.set('b', settings(0.5, ['other'], ['org.music']));
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
  assert.equal(g.operations.filter(operation => operation.expected.serial === '1').at(-1).restore, true);
  await focus.set('b', null);
  assert.deepEqual(g.state.streams[0].volumes, [0.8, 0.4]);
  await focus.close();
});
