import { randomUUID } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync,
  renameSync, unlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { errorCode } from './types.ts';
import type { DeviceSelection, Environment } from './types.ts';

type AudioDevice = { name: string; class?: unknown; description?: unknown; device?: unknown;
  bluetooth?: unknown; outputHint?: unknown };
export interface LocalRoutes { version: 2; active: string; fallback?: string; routes: Record<string, DeviceSelection> }
export function routeName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) {
    throw new Error('Route names must be 1–32 lowercase letters, digits or hyphens, starting with a letter');
  }
  return name;
}
type LocalDevices = DeviceSelection & { version: 1 };

export function deviceChoices(devices: unknown, kind: string, current?: string) {
  if (!Array.isArray(devices) || devices.length > 1024) throw new Error('Invalid audio device list');
  const seen = new Set();
  return devices.filter((device: unknown): device is AudioDevice => {
    if (!device || typeof device !== 'object') return false;
    const candidate = device as Record<string, unknown>;
    const name = candidate.name;
    if (candidate.class !== kind || typeof name !== 'string' || !name.trim() || name.length > 1024 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(name) || seen.has(name)) return false;
    seen.add(name);
    return kind !== 'Audio/Source' || !name.toLowerCase().includes('monitor');
  }).map(device => {
    const description = typeof device.description === 'string'
      ? device.description.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 160).trim() : '';
    return { name: device.name, bluetooth: device.bluetooth === true,
      outputHint: device.bluetooth !== true && (device.outputHint === 'speakers' || device.outputHint === 'headphones')
        ? device.outputHint : 'unknown' as const,
      ...(typeof device.device === 'string' ? { device: device.device } : {}),
      label: `${description || device.name}${device.name === current ? ' (current)' : ''} — ${device.name}` };
  }).sort((left, right) => Number(right.name === current) - Number(left.name === current));
}

export function deviceSettingsPath(env: Environment = process.env, home = homedir()) {
  const root = env.XDG_CONFIG_HOME || join(home, '.config');
  if (!isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) throw new Error('XDG_CONFIG_HOME must be absolute');
  return join(root, 'paj-voice', 'devices.json');
}

function validate(input: unknown): LocalDevices {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(key => !['version', 'input', 'output', 'inputDevice', 'outputDevice', 'speakerMode'].includes(key))) throw new Error('Invalid local device selection');
  for (const key of ['input', 'output']) {
    const name = value[key];
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 1024 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(name) || ['default', 'auto'].includes(name)) {
      throw new Error('Select exact audio devices using /paj-voice setup');
    }
  }
  const inputName = value.input as string, outputName = value.output as string;
  if (inputName.toLowerCase().includes('monitor')) throw new Error('Capture monitors are not supported');
  const physical: Partial<DeviceSelection> = {};
  for (const key of ['inputDevice', 'outputDevice'] as const) {
    const identity = value[key];
    if (identity === undefined) continue;
    if (typeof identity !== 'string' || !identity.trim() || identity !== identity.trim() ||
        identity.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/u.test(identity)) {
      throw new Error('Invalid physical audio device identity');
    }
    physical[key] = identity;
  }
  if (value.speakerMode !== undefined && typeof value.speakerMode !== 'boolean') {
    throw new Error('Invalid local speaker mode');
  }
  return { version: 1, input: inputName, output: outputName, ...physical,
    ...(value.speakerMode !== undefined ? { speakerMode: value.speakerMode } : {}) };
}

export function loadDevices(file?: string, required?: true): LocalDevices;
export function loadDevices(file: string, required: false): LocalDevices | undefined;
export function loadDevices(file = deviceSettingsPath(), required = true): LocalDevices | undefined {
  const routes = loadRoutes(file);
  if (!routes) {
    if (!required) return undefined;
    throw new Error('No local audio devices selected. Run /paj-voice setup while voice is off.');
  }
  return { version: 1, ...routes.routes[routes.active] };
}

function readStored(file: string): unknown {
  try {
    const directory = lstatSync(dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() ||
        (directory.mode & 0o077)) throw new Error('Local device directory must be private and user-owned');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid!() || info.nlink !== 1 ||
        (info.mode & 0o077) || info.size > 65536) throw new Error('Unsafe local device file');
    const buffer = Buffer.alloc(65537);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > 65536) throw new Error('Local device file is too large');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
}

export function saveDevices(file: string, devices: DeviceSelection) {
  saveRoute(file, 'default', devices);
}

function validateRoutes(input: unknown): LocalRoutes {
  const value = input as Partial<LocalRoutes> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2 ||
      Object.keys(value).some(key => !['version', 'active', 'fallback', 'routes'].includes(key)) ||
      typeof value.active !== 'string' || !value.routes || typeof value.routes !== 'object' || Array.isArray(value.routes) ||
      Object.keys(value.routes).length < 1 || Object.keys(value.routes).length > 16) throw new Error('Invalid local routes');
  const routes: Record<string, DeviceSelection> = Object.create(null);
  for (const [name, selection] of Object.entries(value.routes)) {
    routeName(name);
    routes[name] = validateSelection(selection);
  }
  routeName(value.active);
  if (!Object.hasOwn(routes, value.active)) throw new Error('Invalid current route');
  if (Object.hasOwn(value, 'fallback')) {
    if (typeof value.fallback !== 'string') throw new Error('Invalid fallback route');
    routeName(value.fallback);
    if (!Object.hasOwn(routes, value.fallback)) throw new Error('Unknown fallback route');
  }
  return { version: 2, active: value.active,
    ...(value.fallback !== undefined ? { fallback: value.fallback } : {}), routes };
}

function validateSelection(selection: unknown): DeviceSelection {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || 'version' in selection) {
    throw new Error('Invalid local route selection');
  }
  const { version: _, ...devices } = validate({ ...selection, version: 1 });
  return devices;
}

export function loadRoutes(file = deviceSettingsPath()): LocalRoutes | undefined {
  const value = readStored(file);
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && 'version' in value && value.version === 2) return validateRoutes(value);
  const { version: _, ...selection } = validate(value);
  return { version: 2, active: 'default', routes: { default: selection } };
}

export function sameDeviceSelection(left: DeviceSelection | undefined, right: DeviceSelection | undefined) {
  return !!left && !!right && (['input', 'output', 'inputDevice', 'outputDevice', 'speakerMode'] as const)
    .every(key => left[key] === right[key]);
}

export function saveRoute(file: string, name: string, selection?: DeviceSelection, expected?: DeviceSelection) {
  routeName(name);
  changeRoutes(file, before => {
    if (expected && !sameDeviceSelection(before?.routes[name], expected)) {
      throw new Error('Saved route changed during switching; retry without overwriting it');
    }
    if (!selection && (!before || !Object.hasOwn(before.routes, name))) throw new Error('Unknown saved route');
    return { ...before, version: 2, active: name,
      routes: { ...before?.routes, ...(selection ? { [name]: selection } : {}) } };
  });
}

export function updateRouteProtection(file: string, name: string, speakerMode: boolean, expected: DeviceSelection) {
  routeName(name);
  if (typeof speakerMode !== 'boolean') throw new Error('Invalid local speaker mode');
  changeRoutes(file, before => {
    if (!before || !sameDeviceSelection(before.routes[name], expected)) {
      throw new Error('Saved route changed during confirmation; retry without overwriting it');
    }
    if (before.fallback === name && speakerMode !== true) {
      throw new Error('Automatic fallback requires speaker protection; it cannot be disabled');
    }
    return { ...before, routes: { ...before.routes, [name]: { ...before.routes[name], speakerMode } } };
  });
}

export function saveRouteBinding(file: string, name: string, selection: DeviceSelection,
  expected: LocalRoutes | undefined, activate = false) {
  routeName(name);
  changeRoutes(file, before => {
    if (JSON.stringify(before) !== JSON.stringify(expected)) {
      throw new Error('Saved routes changed during setup; retry without overwriting them');
    }
    if (before?.fallback === name && selection.speakerMode !== true) {
      throw new Error('Automatic fallback requires speaker protection');
    }
    return { ...before, version: 2, active: activate || !before ? name : before.active,
      routes: { ...before?.routes, [name]: selection } };
  });
}

export function saveFallback(file: string, name?: string, selection?: DeviceSelection, expected?: LocalRoutes) {
  if (name !== undefined) routeName(name);
  if (name === undefined && selection !== undefined) throw new Error('Fallback selection requires a route name');
  changeRoutes(file, before => {
    if (!before) throw new Error('Select a preferred route before configuring fallback');
    if (expected && JSON.stringify(before) !== JSON.stringify(expected)) {
      throw new Error('Saved routes changed during fallback confirmation; retry without overwriting them');
    }
    const { fallback: _, ...preferred } = before;
    if (name === undefined) return preferred;
    if (selection !== undefined && name === before.active) {
      throw new Error('Use a distinct route name when configuring fallback devices');
    }
    if (!selection && !Object.hasOwn(before.routes, name)) throw new Error('Unknown fallback route');
    const devices = validateSelection(selection ?? before.routes[name]);
    return { ...preferred, fallback: name,
      routes: { ...before.routes, [name]: { ...devices, speakerMode: true } } };
  });
}

function changeRoutes(file: string, update: (before: LocalRoutes | undefined) => LocalRoutes) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() ||
      (info.mode & 0o077)) throw new Error('Local device directory must be private and user-owned');
  const lockPath = join(directory, '.devices.lock');
  let lock;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error('Local routes are being changed; retry after the other save finishes'); }
  const temporary = join(directory, `.devices-${randomUUID()}.json`);
  let fd;
  try {
    const before = loadRoutes(file);
    const value = validateRoutes(update(before));
    const previous = before ? lstatSync(file) : undefined;
    fd = openSync(temporary, 'wx', 0o600);
    try {
      const serialized = JSON.stringify(value, null, 2) + '\n';
      if (Buffer.byteLength(serialized) > 65536) throw new Error('Local routes exceed storage limit');
      writeFileSync(fd, serialized); fsyncSync(fd);
    }
    finally { closeSync(fd); }
    const current = loadRoutes(file);
    const info = current ? lstatSync(file) : undefined;
    if (JSON.stringify(current) !== JSON.stringify(before) || info?.ino !== previous?.ino ||
        info?.mtimeMs !== previous?.mtimeMs || info?.ctimeMs !== previous?.ctimeMs) {
      throw new Error('Local device selection changed; retry without overwriting it');
    }
    renameSync(temporary, file);
    fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    try { unlinkSync(temporary); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}
