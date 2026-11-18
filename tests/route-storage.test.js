import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync,
  existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices, loadRoutes, saveRoute } from '../src/device-settings.ts';

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

test('route reads are size bounded', t => {
  const { file } = storage(t);
  writeFileSync(file, ' '.repeat(65537), { mode: 0o600 });
  assert.throws(() => loadRoutes(file), /Unsafe|large/);
});
