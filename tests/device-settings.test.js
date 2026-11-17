import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceChoices, saveDevices } from '../src/device-settings.js';

const devices = [
  { name: 'alsa_input.laptop', description: 'Laptop microphone', class: 'Audio/Source' },
  { name: 'bluez_input.headset', description: 'Bluetooth microphone', class: 'Audio/Source' },
  { name: 'speaker.monitor', description: 'Loopback', class: 'Audio/Source' },
  { name: 'bluez_output.headphones', description: 'Sony headphones', class: 'Audio/Sink' },
];

test('device choices have readable names and inspectable IDs, without Bluetooth microphones', () => {
  const input = deviceChoices(devices, 'Audio/Source', 'alsa_input.laptop');
  assert.equal(input.length, 1);
  assert.match(input[0].label, /Laptop microphone.*current.*alsa_input.laptop/);
  const output = deviceChoices(devices, 'Audio/Sink');
  assert.match(output[0].label, /Sony headphones.*bluez_output.headphones/);
  const preferred = deviceChoices([
    { name: 'alsa_output.speakers', description: 'Speakers', class: 'Audio/Sink' }, ...devices,
  ], 'Audio/Sink', 'bluez_output.headphones');
  assert.equal(preferred[0].name, 'bluez_output.headphones');
});

test('selection updates only device IDs in the real shared source, never replacing its symlink', t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-device-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'paj.json'), link = join(directory, 'linked.json');
  const root = { subagents: { opaque: true }, captain: { opaque: ['unchanged'] },
    voice: { version: 1, tts: {}, audio: { input: 'old-input', output: 'old-output', echoCancellation: 'none' } } };
  writeFileSync(source, JSON.stringify(root));
  symlinkSync(source, link);
  saveDevices(link, { input: 'alsa_input.laptop', output: 'bluez_output.headphones' });
  const updated = JSON.parse(readFileSync(source, 'utf8'));
  assert.deepEqual(updated, { ...root, voice: { ...root.voice, audio: { ...root.voice.audio,
    input: 'alsa_input.laptop', output: 'bluez_output.headphones' } } });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const before = readFileSync(source, 'utf8');
  assert.throws(() => saveDevices(link, { input: 'default', output: 'default' }), /configuration/);
  assert.equal(readFileSync(source, 'utf8'), before);
  writeFileSync(source, '{broken');
  assert.throws(() => saveDevices(link, { input: 'a', output: 'b' }));
  assert.equal(readFileSync(source, 'utf8'), '{broken');
});
