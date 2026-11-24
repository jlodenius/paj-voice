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
  let records = [], epoch = 'daemon-one';
  const writes = [];
  const journal = { load: () => structuredClone(records), async save(next) { records = structuredClone(next); } };
  const faults = { restore: false, appliedWithoutAck: false, refuseSave: false };
  const save = journal.save;
  journal.save = async next => { if (faults.refuseSave) throw new Error('disk failure'); await save(next); };
  const graph = { async snapshot() { return { generation: 'core', streams: [structuredClone(stream)] }; },
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
  return { focus, stream, faults, writes, journal, swapEpoch: () => { epoch = 'daemon-two'; } };
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

for (const mismatch of ['epoch', 'identity', 'user gain']) {
  test(`restart never overwrites ${mismatch} mismatch`, async () => {
    const f = fixture();
    await f.focus().set('first', policy);
    if (mismatch === 'epoch') f.swapEpoch();
    else if (mismatch === 'identity') f.stream.appId = 'changed';
    else f.stream.volumes = [0.7, 0.3];
    const engine = f.focus();
    await engine.recover();
    assert.deepEqual(f.writes, [[0.25, 0.125]]);
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
