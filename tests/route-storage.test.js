import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync,
  existsSync, readdirSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices, loadRoutes, saveRoute, saveFallback, sameDeviceSelection } from '../src/device-settings.ts';

function storage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'devices.json') };
}
const desk = { input: 'laptop', output: 'headphones' };
const headset = { input: 'bluez_input.chosen', output: 'bluez_output.chosen',
  inputDevice: 'bluez_card.chosen', outputDevice: 'bluez_card.chosen' };

test('v1 choices migrate in memory without writes and survive named-route atomic saves', t => {
  const { dir, file } = storage(t);
  const raw = JSON.stringify({ version: 1, ...desk });
  writeFileSync(file, raw, { mode: 0o600 });
  assert.deepEqual(loadRoutes(file), { version: 2, active: 'default', routes: { default: desk } });
  assert.equal(readFileSync(file, 'utf8'), raw);
  saveRoute(file, 'headset', headset);
  assert.equal(loadRoutes(file).active, 'headset');
  assert.deepEqual(loadRoutes(file).routes.default, desk);
  assert.deepEqual(loadDevices(file), { version: 1, ...headset });
  saveRoute(file, 'default');
  assert.deepEqual(loadDevices(file), { version: 1, ...desk });
  assert.deepEqual(readdirSync(dir), ['devices.json']);
});

test('invalid names, defaults, monitors, schemas and excessive routes never overwrite saved choices', t => {
  const { file } = storage(t);
  saveRoute(file, 'desk', desk);
  const before = readFileSync(file, 'utf8');
  for (const name of ['__proto__', 'constructor', 'Desk', '', 'x'.repeat(33), 'desk\n']) {
    assert.throws(() => saveRoute(file, name, desk));
  }
  for (const selection of [{ input: 'default', output: 'auto' }, { ...desk, input: 'capture.monitor' },
    { ...desk, extra: 'unsupported' }, { ...desk, inputDevice: 'bad\nidentity' }, { ...desk, version: 1 }]) {
    assert.throws(() => saveRoute(file, 'invalid', selection));
  }
  assert.throws(() => saveRoute(file, 'unknown'));
  assert.equal(readFileSync(file, 'utf8'), before);
  for (let i = 0; i < 15; i++) saveRoute(file, `route-${i}`, desk);
  assert.throws(() => saveRoute(file, 'overflow', desk));
  const valid = readFileSync(file, 'utf8');
  for (const value of [null, [], { version: 2, active: 'missing', routes: { desk } },
    { version: 2, active: 'desk', routes: { desk }, extra: true },
    { version: 2, active: 'desk', routes: { desk: { ...desk, extra: true } } }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadRoutes(file));
  }
  writeFileSync(file, valid);
});

test('private route writes refuse held concurrent-save locks and unsafe file links', t => {
  const { dir, file } = storage(t);
  saveRoute(file, 'desk', desk);
  const before = readFileSync(file, 'utf8');
  const lock = join(dir, '.devices.lock');
  writeFileSync(lock, 'held', { mode: 0o600 });
  assert.throws(() => saveRoute(file, 'headset', headset), /being changed/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readFileSync(lock, 'utf8'), 'held');
  rmSync(lock);
  const hard = join(dir, 'hard');
  linkSync(file, hard);
  assert.throws(() => loadRoutes(file), /Unsafe/);
  assert.throws(() => saveRoute(file, 'headset', headset), /Unsafe/);
  assert.equal(existsSync(lock), false);
  rmSync(hard);
  const symlink = join(dir, 'sym');
  symlinkSync(file, symlink);
  assert.throws(() => loadRoutes(symlink));
  assert.throws(() => saveRoute(symlink, 'headset', headset));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('selecting a route refuses a definition changed since audio preflight', t => {
  const { file } = storage(t);
  saveRoute(file, 'headset', headset);
  saveRoute(file, 'desk', desk);
  const changed = { ...headset, inputDevice: 'bluez_card.other' };
  saveRoute(file, 'headset', changed);
  saveRoute(file, 'desk');
  assert.throws(() => saveRoute(file, 'headset', undefined, headset), /changed/);
  assert.equal(loadRoutes(file).active, 'desk');
  assert.deepEqual(loadRoutes(file).routes.headset, changed);
});

test('fallback configuration preserves preferred selection, named routes and manual selection behavior', t => {
  const { dir, file } = storage(t);
  saveRoute(file, 'headset', headset);
  saveFallback(file, 'desk', desk);
  assert.deepEqual(loadRoutes(file), { version: 2, active: 'headset', fallback: 'desk',
    routes: Object.assign(Object.create(null), { headset, desk: { ...desk, speakerMode: true } }) });
  assert.deepEqual(loadDevices(file), { version: 1, ...headset });
  saveRoute(file, 'headset', { ...headset, output: 'new-output' });
  assert.equal(loadRoutes(file).fallback, 'desk');
  saveRoute(file, 'desk');
  assert.equal(loadRoutes(file).active, 'desk');
  assert.equal(loadRoutes(file).fallback, 'desk');
  saveFallback(file, 'headset');
  assert.equal(loadRoutes(file).active, 'desk');
  assert.equal(loadRoutes(file).fallback, 'headset');
  saveFallback(file);
  assert.equal(Object.hasOwn(loadRoutes(file), 'fallback'), false);
  assert.equal(loadRoutes(file).active, 'desk');
  assert.deepEqual(loadRoutes(file).routes.desk, { ...desk, speakerMode: true });
  assert.equal(loadRoutes(file).routes.headset.speakerMode, true);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['devices.json']);
});

test('fallback upserts cannot overwrite the active preferred route', t => {
  const { dir, file } = storage(t);
  saveRoute(file, 'headset', headset);
  saveFallback(file, 'desk', desk);
  const before = readFileSync(file, 'utf8');
  for (const selection of [desk, headset]) {
    assert.throws(() => saveFallback(file, 'headset', selection), /distinct.*name/i);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(loadDevices(file), { version: 1, ...headset });
  }
  assert.deepEqual(readdirSync(dir), ['devices.json']);
  saveFallback(file, 'headset');
  assert.equal(loadRoutes(file).active, 'headset');
  assert.equal(loadRoutes(file).fallback, 'headset');
  assert.deepEqual(loadDevices(file), { version: 1, ...headset, speakerMode: true });
});

test('fallback requires preferred routes and validates names, references and exact selections', t => {
  const { file } = storage(t);
  assert.throws(() => saveFallback(file, 'desk', desk), /preferred/i);
  assert.throws(() => saveFallback(file), /preferred/i);
  saveRoute(file, 'headset', headset);
  const before = readFileSync(file, 'utf8');
  for (const name of ['unknown', '__proto__', 'constructor', 'Desk', '', 'x'.repeat(33)]) {
    assert.throws(() => saveFallback(file, name));
  }
  for (const selection of [{ ...desk, extra: true }, { ...desk, input: 'auto' },
    { ...desk, input: 'capture.monitor' }, { ...desk, outputDevice: 'bad\nidentity' },
    { ...desk, version: 1 }]) {
    assert.throws(() => saveFallback(file, 'desk', selection));
  }
  assert.throws(() => saveFallback(file, undefined, desk));
  assert.equal(readFileSync(file, 'utf8'), before);
  for (const fallback of [null, false, 3, '', 'missing', '__proto__', {}, []]) {
    writeFileSync(file, JSON.stringify({ version: 2, active: 'headset', routes: { headset }, fallback }));
    assert.throws(() => loadRoutes(file));
  }
});

test('fallback migrates legacy selections without changing the preferred route', t => {
  const { file } = storage(t);
  writeFileSync(file, JSON.stringify({ version: 1, ...headset }), { mode: 0o600 });
  saveFallback(file, 'desk', desk);
  assert.deepEqual(loadRoutes(file), { version: 2, active: 'default', fallback: 'desk',
    routes: Object.assign(Object.create(null), { default: headset, desk: { ...desk, speakerMode: true } }) });
});

test('private speaker mode validates booleans and participates in route concurrency checks', t => {
  const { file } = storage(t);
  for (const speakerMode of [true, false]) {
    writeFileSync(file, JSON.stringify({ version: 1, ...desk, speakerMode }), { mode: 0o600 });
    assert.equal(loadDevices(file).speakerMode, speakerMode);
    saveRoute(file, 'desk', { ...desk, speakerMode });
    assert.equal(loadRoutes(file).routes.desk.speakerMode, speakerMode);
  }
  for (const speakerMode of [null, 0, 1, 'true', {}, []]) {
    assert.throws(() => saveRoute(file, 'desk', { ...desk, speakerMode }), /speaker mode/);
    assert.throws(() => saveFallback(file, 'invalid', { ...desk, speakerMode }), /speaker mode/);
    writeFileSync(file, JSON.stringify({ version: 1, ...desk, speakerMode }));
    assert.throws(() => loadDevices(file), /speaker mode/);
    writeFileSync(file, JSON.stringify({ version: 1, ...desk }));
  }
  saveRoute(file, 'desk', desk);
  saveFallback(file, 'desk');
  assert.equal(loadRoutes(file).active, 'desk');
  assert.equal(loadRoutes(file).routes.desk.speakerMode, true);
  saveFallback(file);
  assert.equal(loadDevices(file).speakerMode, true);
  assert.equal(sameDeviceSelection(desk, { ...desk, speakerMode: true }), false);
  assert.equal(sameDeviceSelection({ ...desk, speakerMode: false }, { ...desk, speakerMode: true }), false);
  assert.equal(sameDeviceSelection({ ...desk, speakerMode: true }, { ...desk, speakerMode: true }), true);
  assert.throws(() => saveRoute(file, 'desk', undefined, desk), /changed/);
});

test('fallback uses private path checks and the shared concurrent-save lock', t => {
  const { dir, file } = storage(t);
  saveRoute(file, 'headset', headset);
  const before = readFileSync(file, 'utf8');
  const lock = join(dir, '.devices.lock');
  writeFileSync(lock, 'held', { mode: 0o600 });
  assert.throws(() => saveFallback(file, 'desk', desk), /being changed/);
  assert.equal(readFileSync(file, 'utf8'), before);
  rmSync(lock);
  const hard = join(dir, 'hard');
  linkSync(file, hard);
  assert.throws(() => saveFallback(file, 'desk', desk), /Unsafe/);
  rmSync(hard);
  const link = join(dir, 'link');
  symlinkSync(file, link);
  assert.throws(() => saveFallback(link, 'desk', desk));
  chmodSync(file, 0o644);
  assert.throws(() => saveFallback(file, 'desk', desk), /Unsafe/);
  chmodSync(file, 0o600);
  chmodSync(dir, 0o755);
  assert.throws(() => saveFallback(file, 'desk', desk), /private/);
  chmodSync(dir, 0o700);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(lock), false);
});

test('fallback atomic saves refuse out-of-band changes before rename', t => {
  const { dir, file } = storage(t);
  saveRoute(file, 'headset', headset);
  const external = JSON.stringify({ version: 2, active: 'headset', routes: {
    headset: { ...headset, output: 'externally-changed' } } });
  const original = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (...args) => {
    original(...args);
    if (typeof args[0] === 'number') original(file, external);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => saveFallback(file, 'desk', desk), /changed/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(file, 'utf8'), external);
  assert.deepEqual(readdirSync(dir), ['devices.json']);
});

test('fallback upserts retain route and serialized size limits', t => {
  const { file } = storage(t);
  saveRoute(file, 'headset', headset);
  for (let i = 0; i < 15; i++) saveFallback(file, `route-${i}`, desk);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => saveFallback(file, 'overflow', desk));
  assert.equal(readFileSync(file, 'utf8'), before);
  const large = { input: 'a'.repeat(1024), output: 'b'.repeat(1024),
    inputDevice: 'c'.repeat(1024), outputDevice: 'd'.repeat(1024) };
  for (let i = 0; i < 15; i++) saveFallback(file, `route-${i}`, large);
  saveRoute(file, 'route-0');
  const full = readFileSync(file, 'utf8');
  assert.throws(() => saveFallback(file, 'headset', large), /storage limit/);
  assert.equal(readFileSync(file, 'utf8'), full);
});

test('route reads are size bounded', t => {
  const { file } = storage(t);
  writeFileSync(file, ' '.repeat(65537), { mode: 0o600 });
  assert.throws(() => loadRoutes(file), /Unsafe|large/);
});
