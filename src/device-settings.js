import { randomUUID } from 'node:crypto';
import { constants, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync,
  renameSync, unlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

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

export function deviceSettingsPath(env = process.env, home = homedir()) {
  const root = env.XDG_CONFIG_HOME || join(home, '.config');
  if (!isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) throw new Error('XDG_CONFIG_HOME must be absolute');
  return join(root, 'paj-voice', 'devices.json');
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(key => !['version', 'input', 'output'].includes(key))) throw new Error('Invalid local device selection');
  for (const key of ['input', 'output']) {
    const name = value[key];
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 1024 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(name) || ['default', 'auto'].includes(name)) {
      throw new Error('Select exact audio devices using /paj-voice setup');
    }
  }
  if (value.input.startsWith('bluez') || value.input.toLowerCase().includes('monitor')) {
    throw new Error('Bluetooth microphones and capture monitors are not supported');
  }
  return { version: 1, input: value.input, output: value.output };
}

export function loadDevices(file = deviceSettingsPath(), required = true) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!required) return undefined;
    throw new Error('No local audio devices selected. Run /paj-voice setup while voice is off.');
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 ||
        (info.mode & 0o077) || info.size > 8192) throw new Error('Unsafe local device file');
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > 8192) throw new Error('Local device file is too large');
    return validate(JSON.parse(raw));
  } finally { closeSync(fd); }
}

export function saveDevices(file, devices) {
  const value = validate({ version: 1, ...devices });
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o077)) throw new Error('Local device directory must be private and user-owned');
  const before = loadDevices(file, false);
  const temporary = join(directory, `.devices-${randomUUID()}.json`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (JSON.stringify(loadDevices(file, false)) !== JSON.stringify(before)) {
      throw new Error('Local device selection changed; retry without overwriting it');
    }
    renameSync(temporary, file);
    fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
