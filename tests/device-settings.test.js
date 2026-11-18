import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceChoices, deviceSettingsPath, loadDevices, saveDevices } from '../src/device-settings.ts';

const devices = [
  { name: 'alsa_input.laptop', description: 'Laptop microphone', class: 'Audio/Source' },
  { name: 'bluez_input.headset', description: 'Bluetooth microphone', class: 'Audio/Source' },
  { name: 'speaker.monitor', description: 'Loopback', class: 'Audio/Source' },
  { name: 'bluez_output.headphones', description: 'Sony headphones', class: 'Audio/Sink' },
];

test('device choices are readable, current-first and accept Bluetooth but reject monitors', () => {
  const input = deviceChoices(devices, 'Audio/Source', 'alsa_input.laptop');
  assert.equal(input.length, 2);
  assert.match(input[0].label, /Laptop microphone.*current.*alsa_input.laptop/);
  const output = deviceChoices([{ name: 'speakers', class: 'Audio/Sink' }, ...devices],
    'Audio/Sink', 'bluez_output.headphones');
  assert.match(output[0].label, /Sony headphones/);
});

test('device IDs live in a private local file, without reading or changing shared preferences', t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-device-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shared = join(directory, 'paj.json');
  writeFileSync(shared, '{shared preferences remain byte-identical}');
  const file = deviceSettingsPath({ XDG_CONFIG_HOME: directory });
  assert.equal(loadDevices(file, false), undefined);
  assert.throws(() => loadDevices(file), /paj-voice setup/);
  saveDevices(file, { input: 'alsa_input.laptop', output: 'bluez_output.headphones' });
  assert.deepEqual(loadDevices(file), { version: 1, input: 'alsa_input.laptop', output: 'bluez_output.headphones' });
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(directory, 'paj-voice')).mode & 0o777, 0o700);
  assert.equal(readFileSync(shared, 'utf8'), '{shared preferences remain byte-identical}');
  const before = readFileSync(file, 'utf8');
  assert.throws(() => saveDevices(file, { input: 'default', output: 'default' }));
  assert.equal(readFileSync(file, 'utf8'), before);
  chmodSync(file, 0o644);
  assert.throws(() => loadDevices(file), /Unsafe/);
  chmodSync(file, 0o600);
  writeFileSync(file, '{broken');
  assert.throws(() => saveDevices(file, { input: 'a', output: 'b' }));
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('local device paths respect XDG and refuse symlink files', t => {
  assert.equal(deviceSettingsPath({}, '/home/test'), '/home/test/.config/paj-voice/devices.json');
  assert.throws(() => deviceSettingsPath({ XDG_CONFIG_HOME: 'relative' }), /absolute/);
  const directory = mkdtempSync(join(tmpdir(), 'voice-device-symlink-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'target');
  writeFileSync(target, '{}', { mode: 0o600 });
  const link = join(directory, 'link');
  symlinkSync(target, link);
  assert.throws(() => loadDevices(link));
  assert.throws(() => saveDevices(link, { input: 'input', output: 'output' }));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), '{}');
});
