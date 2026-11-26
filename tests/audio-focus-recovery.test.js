import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { createAudioFocus } from '../src/audio-focus.ts';
import { openFocusJournal } from '../src/audio-focus-journal.ts';

const policy = { mode: 'duck-all', gain: 0.25, apps: [], excludeApps: [] };
function fixture() {
  const stream = { id: 5, serial: '55', appId: 'music', binary: 'music', role: 'Music',
    name: 'music', volumes: [1, 0.5], muted: false };
  let records = [], epoch = 'daemon-one', generation = 'core';
  const writes = [];
  const journal = { load: () => structuredClone(records), async save(next) { records = structuredClone(next); } };
  const faults = { restore: false, appliedWithoutAck: false, refuseSave: false };
  const save = journal.save;
  journal.save = async next => { if (faults.refuseSave) throw new Error('disk failure'); await save(next); };
  const graph = { async snapshot() { return { generation, streams: [structuredClone(stream)] }; },
    async compareAndSet(_generation, before, volumes, restoring) {
      assert.deepEqual(before.volumes, stream.volumes);
      assert.ok(records.length > 0, 'journal must reach durable storage before CAS');
      writes.push([...volumes]);
      if (restoring && faults.restore) return false;
      stream.volumes = [...volumes];
      if (faults.appliedWithoutAck) return false;
      return true;
    } };
  const focus = options => createAudioFocus(graph, { journal, recoveryEpoch: async () => epoch, releaseMs: 0,
    recoveryDelayMs: 25, ...options });
  return { focus, stream, faults, writes, journal,
    swapEpoch: () => { epoch = 'daemon-two'; },
    swapCore: () => { generation = 'new-core'; },
  };
}

test('a volume write whose acknowledgement was lost is recovered after broker restart', async () => {
  const f = fixture();
  const first = f.focus();
  f.faults.appliedWithoutAck = true;
  await first.set('first', policy);
  assert.deepEqual(f.stream.volumes, [0.25, 0.125]);
  assert.deepEqual(f.journal.load()[0].baseline, [1, 0.5]);
  f.faults.appliedWithoutAck = false;
  const next = f.focus();
  await next.recover();
  assert.deepEqual(f.stream.volumes, [1, 0.5]);
  assert.deepEqual(f.journal.load(), []);
  await next.close();
});

test('reopening the private journal recovers an acknowledged duck after engine replacement', {
  skip: !!process.env.NIX_BUILD_TOP && statSync('/').uid === 65534,
}, async t => {
  const dir = await mkdtemp('/tmp/paj-focus-recovery-');
  t.after(() => rm(dir, { force: true, recursive: true }));
  const f = fixture();
  const firstJournal = await openFocusJournal(dir);
  const bind = journal => ({ load: journal.load, async save(records) {
    await journal.save(records);
    await f.journal.save(records);
  } });
  await f.focus({ journal: bind(firstJournal) }).set('first', policy);
  assert.deepEqual(f.stream.volumes, [0.25, 0.125]);
  const secondJournal = await openFocusJournal(dir);
  assert.deepEqual(secondJournal.load()[0].baseline, [1, 0.5]);
  const next = f.focus({ journal: bind(secondJournal) });
  await next.recover();
  assert.deepEqual(f.stream.volumes, [1, 0.5]);
  assert.deepEqual((await openFocusJournal(dir)).load(), []);
  await next.close();
});

test('a failed journal write prevents attenuation', async () => {
  const f = fixture();
  const engine = f.focus();
  f.faults.refuseSave = true;
  await engine.set('first', policy);
  assert.deepEqual(f.stream.volumes, [1, 0.5]);
  assert.deepEqual(f.writes, []);
  await engine.close();
});

test('a stale Discord record never blocks current ducking or supplies a replacement baseline', async t => {
  const f = fixture();
  await f.journal.save([{ generation: 'old-core', epoch: 'old-daemon',
    stream: { ...f.stream, name: 'Discord', volumes: [0.00001, 0.00001] },
    baseline: [0.0001, 0.0001] }]);
  const engine = f.focus();
  t.after(() => engine.close());
  await engine.set('current', policy);
  assert.deepEqual(f.writes, [[0.25, 0.125]]);
  assert.deepEqual(f.journal.load().map(r => [r.generation, r.epoch, r.baseline]),
    [['core', 'daemon-one', [1, 0.5]]]);
  await engine.set('current', null, true);
  assert.deepEqual(f.writes, [[0.25, 0.125], [1, 0.5]]);
  assert.deepEqual(f.journal.load(), []);
});

test('retiring an old record preserves and recovers a current record in the same journal', async t => {
  const f = fixture();
  const old = { generation: 'old-core', epoch: 'old-daemon', stream: { ...f.stream }, baseline: [0.8, 0.4] };
  const current = { generation: 'core', epoch: 'daemon-one', stream: { ...f.stream, volumes: [0.25, 0.125] }, baseline: [1, 0.5] };
  f.stream.volumes = [...current.stream.volumes];
  await f.journal.save([old, current]);
  const saves = [];
  const save = f.journal.save;
  f.journal.save = async records => { saves.push(structuredClone(records)); await save(records); };
  const engine = f.focus();
  t.after(() => engine.close());
  await engine.recover();
  assert.deepEqual(saves, [[current], []]);
  assert.deepEqual(f.writes, [[1, 0.5]]);
});

test('a failed retirement save fences gains and keeps the stale record for retry', async t => {
  const f = fixture();
  const stale = { generation: 'old-core', epoch: 'old-daemon', stream: { ...f.stream }, baseline: [0.8, 0.4] };
  await f.journal.save([stale]);
  const engine = f.focus();
  t.after(() => engine.close());
  f.faults.refuseSave = true;
  await engine.set('current', policy);
  assert.deepEqual(f.journal.load(), [stale]);
  assert.deepEqual(f.writes, []);
  assert.equal(engine.hasUnconfirmedRestorations(), true);
  f.faults.refuseSave = false;
  await engine.set('current', null, true);
  await engine.recover();
  assert.deepEqual(f.journal.load(), []);
  await engine.set('next', policy);
  assert.deepEqual(f.writes, [[0.25, 0.125]]);
});

test('unavailable or unstable PipeWire identity cannot retire a journal entry', async t => {
  for (const identities of [[undefined], ['new-daemon', 'other-daemon']]) {
    const f = fixture();
    const stale = { generation: 'old-core', epoch: 'old-daemon', stream: { ...f.stream }, baseline: [0.8, 0.4] };
    await f.journal.save([stale]);
    let read = 0;
    const engine = f.focus({ recoveryEpoch: async () => identities[read++ % identities.length] });
    t.after(() => engine.close());
    await engine.set('current', policy);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.journal.load(), [stale]);
  }
});

test('a socket identity change during the retirement save blocks writes from that snapshot', async t => {
  const f = fixture();
  const stale = { generation: 'old-core', epoch: 'old-daemon', stream: { ...f.stream }, baseline: [0.8, 0.4] };
  await f.journal.save([stale]);
  const currentEpoch = 'daemon-one';
  let saveInProgress = false;
  const save = f.journal.save;
  f.journal.save = async records => { await save(records); saveInProgress = true; };
  const engine = f.focus({ recoveryEpoch: async () => saveInProgress ? undefined : currentEpoch });
  t.after(() => engine.close());
  await engine.set('current', policy);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.journal.load(), []);
});

for (const mismatch of ['epoch', 'core', 'identity', 'user gain']) {
  test(`restart never overwrites ${mismatch} mismatch`, async () => {
    const f = fixture();
    await f.focus().set('first', policy);
    if (mismatch === 'epoch') f.swapEpoch();
    else if (mismatch === 'core') f.swapCore();
    else if (mismatch === 'identity') f.stream.appId = 'changed';
    else f.stream.volumes = [0.7, 0.3];
    const engine = f.focus();
    await engine.recover();
    assert.deepEqual(f.writes, [[0.25, 0.125]]);
    if (mismatch === 'epoch' || mismatch === 'core') {
      assert.equal(f.journal.load().length, 1);
      await engine.set('current', policy);
      assert.deepEqual(f.writes, [[0.25, 0.125]]);
      assert.equal(f.journal.load().length, 1);
    }
    await engine.close();
  });
}

test('an observed gain adjustment cancels recovery even if the user later chooses the old ducked value', async () => {
  const f = fixture();
  const engine = f.focus();
  await engine.set('first', policy);
  f.stream.volumes = [0.7, 0.3];
  await engine.set('first', null, true);
  assert.deepEqual(f.journal.load(), []);
  f.stream.volumes = [0.25, 0.125];
  const restarted = f.focus();
  await restarted.recover();
  assert.deepEqual(f.writes, [[0.25, 0.125]]);
  await restarted.close();
  await engine.close();
});

test('delayed restore waits out errors without treating the ducked gain as a new baseline', async t => {
  const f = fixture();
  const engine = f.focus();
  t.after(() => engine.close());
  await engine.set('first', policy);
  await engine.set('overlap', policy);
  await engine.set('first', null, true);
  assert.deepEqual(f.writes, [[0.25, 0.125]]);
  f.faults.restore = true;
  await engine.set('overlap', null, true);
  assert.deepEqual(f.stream.volumes, [0.25, 0.125]);
  assert.equal(f.journal.load().length, 1);
  f.faults.restore = false;
  const limit = Date.now() + 1500;
  while (f.stream.volumes[0] !== 1 && Date.now() < limit) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.stream.volumes, [1, 0.5]);
});
