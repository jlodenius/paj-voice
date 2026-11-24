import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { openFocusJournal } from '../src/audio-focus-journal.ts';

// The Nix sandbox's root is owned by nobody, not a trusted journal ancestor.
const diskTest = process.env.NIX_BUILD_TOP && statSync('/').uid === 65534 ? test.skip : test;
const document = (records = [], version = 1) => JSON.stringify({ version, records });
const record = (id = 12) => ({
  generation: '5', epoch: 'boot:server',
  stream: {
    serial: String(id), id, appId: 'music', binary: '', role: 'Music',
    name: 'Music stream', volumes: [0.2, 0.1], muted: false,
    associatedClient: {
      serial: '6', id: 6, source: 'node', appId: 'music', binary: '', role: '',
      name: '', applicationName: 'Music',
    },
  },
  baseline: [0.8, 0.4], candidate: [0.3, 0.15],
});

async function fixture(t) {
  const runtime = await mkdtemp('/tmp/paj-focus-journal-test-');
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const directory = join(runtime, 'paj-voice-focus');
  await mkdir(directory, { mode: 0o700 });
  return {
    runtime, directory, file: join(directory, 'recovery-v1.json'), staging: join(directory, 'recovery-v1.tmp'),
  };
}

const ownerWrite = (path, data) => writeFile(path, data, { mode: 0o600 });

diskTest('journal survives reopening and atomically replaces private snapshots', async t => {
  const { directory, file, staging } = await fixture(t);
  const journal = await openFocusJournal(directory);
  assert.deepEqual(journal.load(), []);
  await journal.save([record()]);
  const first = await lstat(file);
  assert.equal(first.mode & 0o7777, 0o600);
  assert.equal(first.uid, process.getuid());
  assert.equal(first.nlink, 1);
  assert.deepEqual((await openFocusJournal(directory)).load(), [record()]);

  const next = record();
  next.stream.volumes = next.candidate;
  delete next.candidate;
  await journal.save([next]);
  assert.notEqual((await lstat(file)).ino, first.ino);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, records: [next] });
  assert.deepEqual((await openFocusJournal(directory)).load(), [next]);
  await assert.rejects(lstat(staging), { code: 'ENOENT' });

  await journal.save([]);
  assert.deepEqual((await openFocusJournal(directory)).load(), []);
});

diskTest('crash staging files are never loaded and can be replaced under broker ownership', async t => {
  const { directory, file, staging } = await fixture(t);
  await ownerWrite(staging, document([record(13)]));
  assert.deepEqual((await openFocusJournal(directory)).load(), []);
  await ownerWrite(file, document([record()]));
  await ownerWrite(staging, 'truncated');
  const journal = await openFocusJournal(directory);
  assert.deepEqual(journal.load(), [record()]);
  await journal.save([record(14)]);
  assert.deepEqual((await openFocusJournal(directory)).load(), [record(14)]);
  await assert.rejects(lstat(staging), { code: 'ENOENT' });
});

diskTest('queued saves snapshot caller inputs and load returns independent copies', async t => {
  const { directory } = await fixture(t);
  const journal = await openFocusJournal(directory);
  const one = journal.save([record()]);
  const value = record(13);
  const two = journal.save([value]);
  value.baseline[0] = 3;
  await Promise.all([one, two]);
  const loaded = journal.load();
  loaded[0].stream.volumes[0] = 2;
  assert.deepEqual(journal.load(), [record(13)]);
  assert.deepEqual((await openFocusJournal(directory)).load(), [record(13)]);
});

diskTest('rejects corrupt, oversized, unknown-version, and invalid nested documents', async t => {
  const { directory, file } = await fixture(t);
  const badStream = extra => ({ ...record(), stream: { ...record().stream, ...extra } });
  const inputs = [
    ['truncated', '{"version":1,'],
    ['invalid UTF-8', Buffer.from([0xff, 0xff])],
    ['version', document([], 2)],
    ['unknown envelope field', '{"version":1,"records":[],"more":null}'],
    ['epoch', document([{ ...record(), epoch: '\n' }])],
    ['duplicate identity', document([record(), { ...record(), epoch: 'another' }])],
    ['candidate channels', document([{ ...record(), candidate: [0.2] }])],
    ['unknown record field', document([{ ...record(), gain: 0.2 }])],
    ['unsafe name', document([badStream({ name: 'http://music' })])],
    ['invalid volume', document([badStream({ volumes: [0.2, 4.01] })])],
    ['invalid client', document([badStream({ associatedClient: { ...record().stream.associatedClient, source: 'guess' } })])],
    ['unknown client field', document([badStream({ associatedClient: { ...record().stream.associatedClient, url: 'extra' } })])],
    ['too many records', document(Array.from({ length: 129 }, (_, i) => record(i + 100)))],
    ['too many bytes', document() + ' '.repeat(1024 * 1024)],
  ];
  for (const [label, input] of inputs) {
    await ownerWrite(file, input);
    await assert.rejects(openFocusJournal(directory), /focus recovery/i, label);
  }
});

diskTest('invalid saves and corruption after open do not replace the published file', async t => {
  const { directory, file } = await fixture(t);
  const journal = await openFocusJournal(directory);
  const full = Array.from({ length: 128 }, (_, i) => record(i + 100));
  await journal.save(full);
  await assert.rejects(journal.save([...full, record()]), /invalid focus recovery records/i);
  await assert.rejects(journal.save([{ ...record(), baseline: [0.5, NaN] }]), /invalid focus recovery record/i);
  assert.deepEqual((await openFocusJournal(directory)).load(), full);
  await ownerWrite(file, '{');
  await assert.rejects(journal.save([]), /malformed focus recovery file/i);
  assert.equal(await readFile(file, 'utf8'), '{');
});

diskTest('rejects unsafe, nonexistent, and replaced directories', async t => {
  const { runtime, directory } = await fixture(t);
  await assert.rejects(openFocusJournal(directory + '/.'), /invalid focus recovery directory/i);
  await assert.rejects(openFocusJournal(join(runtime, 'absent')), { code: 'ENOENT' });
  await chmod(directory, 0o750);
  await assert.rejects(openFocusJournal(directory), /unsafe focus recovery directory/i);
  await chmod(directory, 0o700);
  const direct = join(runtime, 'symlink');
  await symlink(directory, direct);
  await assert.rejects(openFocusJournal(direct), /unsafe focus recovery directory/i);
  await mkdir(join(directory, 'sub'), { mode: 0o700 });
  await assert.rejects(openFocusJournal(join(direct, 'sub')), /unsafe focus recovery directory parent/i);
  const journal = await openFocusJournal(directory);
  await rename(directory, join(runtime, 'old'));
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(journal.save([]), /focus recovery directory changed/i);
});

diskTest('rejects nonprivate files, directories, symlinks and hard links without touching targets', async t => {
  const { runtime, directory, file, staging } = await fixture(t);
  const target = join(runtime, 'target');
  await ownerWrite(target, 'untouched');
  for (const path of [file, staging]) {
    await writeFile(path, document(), { mode: 0o644 });
    await chmod(path, 0o644);
    await assert.rejects(openFocusJournal(directory), /unsafe focus recovery file/i);
    await rm(path);
    await mkdir(path, { mode: 0o700 });
    await assert.rejects(openFocusJournal(directory), /unsafe focus recovery file/i);
    await rm(path, { recursive: true });
    await symlink(target, path);
    await assert.rejects(openFocusJournal(directory), /unsafe focus recovery file/i);
    await rm(path);
    await link(target, path);
    await assert.rejects(openFocusJournal(directory), /unsafe focus recovery file/i);
    await rm(path);
  }
  const journal = await openFocusJournal(directory);
  await symlink(target, staging);
  await assert.rejects(journal.save([]), /unsafe focus recovery file/i);
  assert.equal(await readFile(target, 'utf8'), 'untouched');
});
