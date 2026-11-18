import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import type { SpawnOptions, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BackgroundAudioSettings } from './audio-focus-types.ts';
import { focusRuntimeDirectory, focusSocketPath, verifyFocusSocket, validFocusSettings,
  FOCUS_FRAME_BYTES, FOCUS_HEARTBEAT_MS } from './audio-focus-broker.ts';
import type { FocusFileSystem } from './audio-focus-broker.ts';
import { assertDefaultFocusEnvironment, focusSpawnEnvironment } from './audio-focus-environment.ts';

export interface AudioFocusClientOptions {
  env?: Record<string, string | undefined>;
  onWarning?: (message: string) => void;
  runtimeDir?: string;
  filesystem?: FocusFileSystem;
  connect?: (path: string) => Socket;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function startAudioFocus(settings: BackgroundAudioSettings, options: AudioFocusClientOptions = {}) {
  if (!validFocusSettings(settings) || settings.mode === 'off') {
    return { playing(_token: string) {}, idle(_token: string) {}, async close() {} };
  }
  const policy: BackgroundAudioSettings = { ...settings, apps: [...settings.apps], excludeApps: [...settings.excludeApps] };
  let current: string | undefined;
  let socket: Socket | undefined;
  let opening: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let idleClose: NodeJS.Timeout | undefined;
  let revision = 0;
  let closed = false;
  let failed = false;
  let warned = false;
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const warning = () => {
    if (!warned) {
      warned = true;
      try { options.onWarning?.('Background audio focus unavailable; restoration could not be confirmed'); } catch {}
    }
  };
  const fail = () => {
    failed = true;
    clearInterval(heartbeat);
    clearTimeout(idleClose);
    idleClose = undefined;
    socket?.destroy();
    socket = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Background audio focus connection lost'));
    }
    pending.clear();
    if (!closed) warning();
  };
  const send = (op: string, token?: string): Promise<void> => {
    if (!socket || socket.destroyed || pending.size >= 16 || socket.writableLength > FOCUS_FRAME_BYTES) {
      return Promise.reject(new Error('Background audio focus connection unavailable'));
    }
    const id = ++nextId;
    const message = { v: 1, id, op, ...(token === undefined ? {} : { token }), ...(op === 'set' ? { settings: policy } : {}) };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { fail(); warning(); }, 2500);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      socket!.write(JSON.stringify(message) + '\n');
    });
  };
  const attach = (connected: Socket) => {
    socket = connected;
    buffer = Buffer.alloc(0);
    socket.on('error', () => { if (socket === connected) fail(); });
    socket.on('close', () => { if (socket === connected) fail(); });
    socket.on('data', chunk => {
      if (socket !== connected) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FOCUS_FRAME_BYTES) { fail(); return; }
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        try {
          const reply = JSON.parse(frame) as { v?: unknown; id?: unknown; ok?: unknown; warning?: unknown };
          if (reply.v === 1 && typeof reply.warning === 'string' && reply.warning.length <= 256 &&
              Object.keys(reply).every(key => ['v', 'warning'].includes(key))) {
            try { options.onWarning?.(reply.warning); } catch {}
            continue;
          }
          if (reply.v !== 1 || !Number.isSafeInteger(reply.id) || reply.ok !== true ||
              Object.keys(reply).some(key => !['v', 'id', 'ok'].includes(key))) throw new Error();
          const request = pending.get(reply.id as number);
          if (!request) throw new Error();
          clearTimeout(request.timer);
          pending.delete(reply.id as number);
          request.resolve();
        } catch { fail(); return; }
      }
    });
    heartbeat = setInterval(() => { void send('ping').catch(fail); }, FOCUS_HEARTBEAT_MS);
    heartbeat.unref();
  };
  const connect = async (path: string): Promise<Socket> => {
    await verifyFocusSocket(path, options.filesystem);
    return new Promise((resolve, reject) => {
      const connection = (options.connect ?? createConnection)(path);
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('Focus connect timed out')); }, 400);
      connection.once('error', error => { clearTimeout(timer); reject(error); });
      connection.once('connect', () => { clearTimeout(timer); resolve(connection); });
    });
  };
  const open = async () => {
    const env = { ...(options.env ?? process.env) };
    assertDefaultFocusEnvironment(env);
    const path = await focusSocketPath(options.runtimeDir ??
      await focusRuntimeDirectory(env, options.filesystem), options.filesystem);
    if (closed || !current) return;
    let connected: Socket;
    try { connected = await connect(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      if (closed || !current) return;
      const safeEnv = focusSpawnEnvironment(env);
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      const child = (options.spawn ?? spawnProcess)(process.execPath,
        [fileURLToPath(new URL(`./audio-focus-broker.${extension}`, import.meta.url))],
        { env: safeEnv, detached: true, stdio: 'ignore' });
      child.on('error', () => { if (!closed) warning(); });
      child.unref();
      let lastError: unknown;
      let result: Socket | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (closed || !current) return;
        await new Promise(resolve => setTimeout(resolve, 50));
        try { result = await connect(path); break; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
          lastError = error;
        }
      }
      if (!result) throw lastError ?? new Error('Focus broker did not start');
      connected = result;
    }
    if (closed || !current) { connected.destroy(); return; }
    attach(connected);
    await send('set', current);
  };
  const ensureOpen = () => {
    if (opening || socket || closed || failed || !current) return;
    opening = open().catch(() => { fail(); }).finally(() => {
      opening = undefined;
      if (current && !socket && !closed && !failed) ensureOpen();
    });
  };
  const playing = (token: string) => {
    if (closed || failed || !token || token.length > 256 || current === token) return;
    try { assertDefaultFocusEnvironment(options.env ?? process.env); } catch { fail(); return; }
    current = token;
    revision++;
    clearTimeout(idleClose);
    idleClose = undefined;
    if (socket) {
      if (!heartbeat) {
        heartbeat = setInterval(() => { void send('ping').catch(fail); }, FOCUS_HEARTBEAT_MS);
        heartbeat.unref();
      }
      void send('set', token).catch(fail);
    } else ensureOpen();
  };
  const idle = (token: string) => {
    if (closed || token !== current) return;
    current = undefined;
    const idleRevision = ++revision;
    clearInterval(heartbeat);
    heartbeat = undefined;
    if (socket) {
      const connection = socket;
      void send('idle', token).then(() => {
        if (!closed && !current && revision === idleRevision && socket === connection) {
          clearTimeout(idleClose);
          idleClose = setTimeout(() => {
            idleClose = undefined;
            if (!closed && !current && revision === idleRevision && socket === connection) {
              socket = undefined;
              connection.end();
            }
          }, 2500);
          idleClose.unref();
        }
      }).catch(() => { if (socket === connection) fail(); });
    }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    current = undefined;
    clearInterval(heartbeat);
    clearTimeout(idleClose);
    idleClose = undefined;
    closePromise = (async () => {
      if (failed) warning();
      if (socket && !socket.destroyed) {
        try { await send('close'); } catch { warning(); }
      }
      fail();
      await opening;
    })();
    return closePromise;
  };
  return { playing, idle, close };
}
