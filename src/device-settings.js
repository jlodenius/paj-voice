import { randomUUID } from 'node:crypto';
import { constants, openSync, fstatSync, readFileSync, realpathSync, writeFileSync, fsyncSync,
  closeSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateConfig } from './config.js';

export function deviceChoices(devices, kind, current) {
  if (!Array.isArray(devices) || devices.length > 1024) throw new Error('Invalid audio device list');
  const seen = new Set();
  return devices.filter(device => {
    const name = device?.name;
    if (device?.class !== kind || typeof name !== 'string' || !name.trim() || name.length > 1024 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(name) || seen.has(name)) return false;
    seen.add(name);
    return kind !== 'Audio/Source' || (!name.startsWith('bluez') && !name.toLowerCase().includes('monitor'));
  }).map(device => {
    const description = typeof device.description === 'string'
      ? device.description.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 160).trim() : '';
    return { name: device.name,
      label: `${description || device.name}${device.name === current ? ' (current)' : ''} — ${device.name}` };
  }).sort((left, right) => Number(right.name === current) - Number(left.name === current));
}

export function saveDevices(file, { input, output }) {
  const target = realpathSync(file);
  if (target.startsWith('/nix/store/')) throw new Error('Edit the declarative device settings at their source');
  let fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let info, raw;
  try {
    info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.size > 65536 || (info.mode & 0o022)) {
      throw new Error('Settings must be a bounded, owner-controlled regular file');
    }
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  if (Buffer.byteLength(raw) > 65536) throw new Error('Settings file is too large');
  const root = JSON.parse(raw);
  if (!root || typeof root !== 'object' || Array.isArray(root) || !root.voice ||
      typeof root.voice !== 'object' || Array.isArray(root.voice)) throw new Error('Missing voice preferences');
  const audio = { ...root.voice.audio, input, output };
  validateConfig({ ...root.voice, audio });
  root.voice.audio = audio;
  const data = `${JSON.stringify(root, null, 2)}\n`;
  if (Buffer.byteLength(data) > 65536) throw new Error('Settings file is too large');
  const temporary = join(dirname(target), `.paj-voice-${randomUUID()}.json`);
  try {
    fd = openSync(temporary, 'wx', info.mode & 0o777);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    const latest = lstatSync(target);
    if (realpathSync(file) !== target || !latest.isFile() || latest.ino !== info.ino ||
        latest.dev !== info.dev || readFileSync(target, 'utf8') !== raw) {
      throw new Error('Settings changed during selection; retry without overwriting them');
    }
    renameSync(temporary, target);
    fd = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
