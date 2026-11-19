import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures/extension.js';

test('missing or undefined fixture writers cannot fall through to production private settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-fixture-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateDir = join(directory, 'paj-voice');
  await mkdir(privateDir, { mode: 0o700 });
  const file = join(privateDir, 'devices.json');
  const saved = { version: 2, active: 'desk', routes: {
    desk: { input: 'desk-mic', output: 'desk-speaker' },
    headset: { input: 'headset-mic', output: 'headset-speaker' },
  } };
  const before = JSON.stringify(saved);
  await writeFile(file, before, { mode: 0o600 });
  for (const overrides of [{}, { saveRoute: undefined },
    { saveRoute() { throw new Error('Fake write failed'); } }]) {
    const f = fixture({ env: { XDG_CONFIG_HOME: directory },
      loadRoutes: () => structuredClone(saved), ...overrides });
    await f.command('route headset');
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(f.workers.length, 0);
    assert.match(f.notices.at(-1)[0], /Cannot select saved route/);
  }
});

test('new setup and protection writer seams are forbidden unless explicitly faked', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-protection-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateDir = join(directory, 'paj-voice');
  await mkdir(privateDir, { mode: 0o700 });
  const file = join(privateDir, 'devices.json');
  const saved = { version: 2, active: 'desk', routes: {
    desk: { input: 'synthetic-mic', output: 'synthetic-output' },
  } };
  const before = JSON.stringify(saved);
  await writeFile(file, before, { mode: 0o600 });
  for (const overrides of [{}, { saveRouteBinding: undefined, updateRouteProtection: undefined }]) {
    const f = fixture({ env: { XDG_CONFIG_HOME: directory },
      loadRoutes: () => structuredClone(saved), ...overrides });
    f.pi.exec = async (_executable, args) => {
      assert.deepEqual(args, ['--devices']);
      return { code: 0, stdout: JSON.stringify([
        { name: 'synthetic-mic', class: 'Audio/Source' },
        { name: 'synthetic-output', class: 'Audio/Sink' },
      ]) };
    };
    f.ctx.ui.select = async (_title, choices) => choices[0];
    await f.command('setup desk');
    assert.equal(await readFile(file, 'utf8'), before);
    assert.match(f.notices.at(-1)[0], /Fixture requires an explicit fake/);
    await f.command('protection desk speakers');
    assert.equal(await readFile(file, 'utf8'), before);
    assert.match(f.notices.at(-1)[0], /Fixture requires an explicit fake/);
    assert.equal(f.workers.length, 0);
  }
});

test('misspelled dependency overrides fail before commands can touch private settings', () => {
  assert.throws(() => fixture({ saveAudio() {} }), /Unknown fixture override: saveAudio/);
});
