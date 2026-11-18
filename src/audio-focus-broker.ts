import { createServer, createConnection } from 'node:net';
import type { Server, Socket } from 'node:net';
import { lstat, mkdir, chmod, unlink, rmdir } from 'node:fs/promises';
import { join, isAbsolute, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { BackgroundAudioSettings } from './audio-focus-types.ts';
import { assertDefaultFocusEnvironment } from './audio-focus-environment.ts';

export const FOCUS_FRAME_BYTES = 16384;
export const FOCUS_HEARTBEAT_MS = 2000;
export const FOCUS_DEADLINE_MS = 8000;
const SOCKET_NAME = 'focus-v1.sock';

type Environment = Record<string, string | undefined>;
interface Engine {
  set(owner: string, settings: BackgroundAudioSettings | null, immediate?: boolean): Promise<void>;
  close(): Promise<void>;
}
export interface FocusFileSystem {
  lstat(path: string): Promise<Stats>;
}
const localFileSystem: FocusFileSystem = { lstat };
export interface BrokerOptions {
  engine?: Engine | ((onWarning: (message: string) => void) => Engine);
  filesystem?: FocusFileSystem;
  server?: Server;
  runtimeDir?: string;
  env?: Environment;
  idleMs?: number;
  deadlineMs?: number;
  onWarning?: (message: string) => void;
}

export function validFocusSettings(value: unknown): value is BackgroundAudioSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const list = (v: unknown) => Array.isArray(v) && v.length <= 32 && v.every(item =>
    typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(item));
  return Object.keys(s).every(k => ['mode', 'gain', 'apps', 'excludeApps'].includes(k)) &&
    (s.mode === 'off' || s.mode === 'duck') && typeof s.gain === 'number' &&
    Number.isFinite(s.gain) && s.gain >= 0.05 && s.gain <= 1 && list(s.apps) && list(s.excludeApps) &&
    (s.mode === 'off' || (s.apps as unknown[]).length > 0);
}

async function privateDirectory(path: string, create: boolean, filesystem: FocusFileSystem): Promise<void> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error('Invalid focus runtime path');
  if (resolve(path) !== path) throw new Error('Noncanonical focus runtime path');
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const ancestor = await filesystem.lstat(parent);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() ||
        (ancestor.uid !== 0 && ancestor.uid !== process.getuid?.()) ||
        ((ancestor.mode & 0o022) !== 0 && !(ancestor.uid === 0 && (ancestor.mode & 0o1000)))) {
      throw new Error('Unsafe focus runtime parent');
    }
    if (parent === dirname(parent)) break;
  }
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await filesystem.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Unsafe focus runtime directory');
  }
}

export async function focusRuntimeDirectory(env: Environment = process.env,
  filesystem: FocusFileSystem = localFileSystem): Promise<string> {
  if (env.XDG_RUNTIME_DIR) {
    await privateDirectory(env.XDG_RUNTIME_DIR, false, filesystem);
    const path = join(env.XDG_RUNTIME_DIR, 'paj-voice-focus');
    await privateDirectory(path, true, filesystem);
    return path;
  }
  const base = await filesystem.lstat('/tmp');
  if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== 0 || !(base.mode & 0o1000)) {
    throw new Error('Unsafe temporary directory');
  }
  const path = `/tmp/paj-voice-focus-${process.getuid?.()}`;
  await privateDirectory(path, true, filesystem);
  return path;
}

export async function focusSocketPath(runtimeDir: string,
  filesystem: FocusFileSystem = localFileSystem): Promise<string> {
  await privateDirectory(runtimeDir, false, filesystem);
  const path = join(runtimeDir, SOCKET_NAME);
  if (Buffer.byteLength(path) > 100) throw new Error('Focus socket path too long');
  return path;
}

export async function verifyFocusSocket(path: string,
  filesystem: FocusFileSystem = localFileSystem): Promise<void> {
  const stat = await filesystem.lstat(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Unsafe focus socket');
  }
}

function alive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Focus socket probe timed out')); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

export async function runAudioFocusBroker(options: BrokerOptions = {}) {
  if (options.engine === undefined) {
    assertDefaultFocusEnvironment(process.env);
    assertDefaultFocusEnvironment(options.env ?? process.env);
    if (options.env && options.env.XDG_RUNTIME_DIR !== process.env.XDG_RUNTIME_DIR) {
      throw new Error('Default user PipeWire runtime must match the broker process environment');
    }
  }
  const clients = new Set<Socket>();
  const warn = (message: string) => {
    const warning = message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256);
    try { options.onWarning?.(warning); } catch {}
    const frame = JSON.stringify({ v: 1, warning }) + '\n';
    for (const socket of clients) {
      if (!socket.destroyed && socket.writableLength <= FOCUS_FRAME_BYTES) socket.write(frame);
    }
  };
  const filesystem = options.filesystem ?? localFileSystem;
  const runtimeDir = options.runtimeDir ?? await focusRuntimeDirectory(options.env, filesystem);
  const path = await focusSocketPath(runtimeDir, filesystem);
  const lock = join(runtimeDir, 'starting');
  await mkdir(lock, { mode: 0o700 });
  const server = options.server ?? createServer();
  let engine: Engine;
  try {
    engine = (typeof options.engine === 'function' ? options.engine(warn) : options.engine) ??
      (await import('./audio-focus.ts')).createAudioFocus(
      (await import('./pipewire-focus.ts')).createPipeWireFocusGraph(), { onWarning: warn });
  } catch (error) {
    await rmdir(lock);
    throw error;
  }
  const releases = new Map<Socket, () => Promise<void>>();
  let idle: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  const waitForCleanup = async (job: Promise<void>) => {
    const timer = setTimeout(() => warn('Background audio cleanup is taking longer than expected'), 3000);
    try { await job; } finally { clearTimeout(timer); }
  };
  const scheduleIdle = () => {
    clearTimeout(idle);
    if (!clients.size && !stopping) idle = setTimeout(() => { void close(); }, options.idleMs ?? 2000);
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    clearTimeout(idle);
    closing = (async () => {
      await Promise.allSettled([...releases.values()].map(release => release()));
      for (const socket of clients) socket.destroy();
      await waitForCleanup(engine.close()).catch(() => warn('Background audio restoration could not be confirmed'));
      await new Promise<void>(resolve => server.close(() => resolve()));
    })();
    return closing;
  };
  server.on('connection', socket => {
    if (stopping || clients.size >= 64) { socket.destroy(); return; }
    clearTimeout(idle);
    clients.add(socket);
    let buffer = Buffer.alloc(0);
    let pending = 0;
    let ended = false;
    let token: string | undefined;
    let tail = Promise.resolve();
    const owner = randomUUID();
    let releasePromise: Promise<void> | undefined;
    const release = (closeId?: number) => {
      if (releasePromise) return releasePromise;
      ended = true;
      token = undefined;
      if (closeId === undefined) socket.destroy();
      let cleanup: Promise<void>;
      try { cleanup = engine.set(owner, null, true); }
      catch (error) { cleanup = Promise.reject(error); }
      releasePromise = waitForCleanup(Promise.allSettled([tail, cleanup]).then(results => {
        if (results.some(result => result.status === 'rejected')) throw new Error('Audio focus release failed');
      })).then(() => {
        if (closeId !== undefined && !socket.destroyed) {
          reply(closeId);
          socket.end();
        }
      }).catch(() => {
        warn('Background audio restoration could not be confirmed');
        socket.destroy();
      });
      return releasePromise;
    };
    releases.set(socket, release);
    socket.setTimeout(options.deadlineMs ?? FOCUS_DEADLINE_MS, () => { void release(); });
    socket.on('error', () => { void release(); });
    socket.on('end', () => { void release(); });
    socket.on('close', () => {
      void release().finally(() => {
        clients.delete(socket);
        releases.delete(socket);
        scheduleIdle();
      });
    });
    const reply = (id: number) => {
      if (socket.writableLength > FOCUS_FRAME_BYTES) throw new Error('Focus response backpressure');
      socket.write(JSON.stringify({ v: 1, id, ok: true }) + '\n');
    };
    socket.on('data', chunk => {
      if (ended) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FOCUS_FRAME_BYTES) { void release(); return; }
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        if (++pending > 32) { void release(); return; }
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(frame);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          message = parsed as Record<string, unknown>;
          if (message.v !== 1 || !Number.isSafeInteger(message.id) || (message.id as number) < 0 ||
              typeof message.op !== 'string' || !['set', 'idle', 'ping', 'close'].includes(message.op)) throw new Error();
          const allowed = message.op === 'set' ? ['v', 'id', 'op', 'token', 'settings'] :
            message.op === 'idle' ? ['v', 'id', 'op', 'token'] : ['v', 'id', 'op'];
          if (Object.keys(message).some(k => !allowed.includes(k))) throw new Error();
          if ((message.op === 'set' || message.op === 'idle') &&
              (typeof message.token !== 'string' || !message.token.length || message.token.length > 256)) throw new Error();
          if (message.op === 'set' && (!validFocusSettings(message.settings) || message.settings.mode !== 'duck')) throw new Error();
        } catch { void release(); return; }
        if (message.op === 'close') { void release(message.id as number); return; }
        tail = tail.then(async () => {
          if (ended) return;
          if (message.op === 'set') {
            token = message.token as string;
            await engine.set(owner, message.settings as unknown as BackgroundAudioSettings);
          } else if (message.op === 'idle' && token === message.token) {
            token = undefined;
            await engine.set(owner, null);
          }
          if (!ended) reply(message.id as number);
        }).catch(() => { warn('Background audio focus failed'); void release(); }).finally(() => { pending--; });
      }
    });
  });
  let bound = false;
  try {
    try {
      await verifyFocusSocket(path, filesystem);
      if (await alive(path)) throw new Error('Audio focus broker already running');
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    bound = true;
    await chmod(path, 0o600);
  } catch (error) {
    if (bound) await close();
    else await waitForCleanup(engine.close()).catch(() => {});
    throw error;
  } finally {
    await rmdir(lock);
  }
  server.on('error', () => { warn('Background audio broker socket failed'); void close(); });
  scheduleIdle();
  return { path, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runAudioFocusBroker({ onWarning: message => process.stderr.write(message + '\n') }).then(broker => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void broker.close(); });
  }).catch(() => { process.exitCode = 1; });
}
