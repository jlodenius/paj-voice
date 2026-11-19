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
import { safeFocusDiagnostic, focusErrorCode, focusElapsed, focusSignal, decodeFocusDiagnostic,
  isFocusDiagnosticMessage } from './audio-focus-diagnostics.ts';
import type { FocusDiagnostic } from './audio-focus-diagnostics.ts';

export interface AudioFocusClientOptions {
  env?: Record<string, string | undefined>;
  onWarning?: (message: string) => void;
  onDiagnostic?: (event: FocusDiagnostic) => void;
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
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void;
    timer: NodeJS.Timeout; operation: 'set' | 'idle' | 'ping' | 'close'; started: number }>();
  const diagnostic = (event: FocusDiagnostic) => {
    const safe = safeFocusDiagnostic(event);
    if (safe) { try { options.onDiagnostic?.(safe); } catch {} }
  };
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
  const send = (op: 'set' | 'idle' | 'ping' | 'close', token?: string): Promise<void> => {
    if (!socket || socket.destroyed || pending.size >= 16 || socket.writableLength > FOCUS_FRAME_BYTES) {
      diagnostic({ component: 'client', operation: op, reason: 'request_unavailable' });
      return Promise.reject(new Error('Background audio focus connection unavailable'));
    }
    const id = ++nextId;
    const message = { v: 1, id, op, ...(token === undefined ? {} : { token }), ...(op === 'set' ? { settings: policy } : {}) };
    return new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const timer = setTimeout(() => {
        diagnostic({ component: 'client', operation: op, reason: 'ack_timeout',
          elapsedMs: focusElapsed(started), timeoutMs: 2500 });
        fail(); warning();
      }, 2500);
      timer.unref();
      pending.set(id, { resolve, reject, timer, operation: op, started });
      try { socket!.write(JSON.stringify(message) + '\n'); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        diagnostic({ component: 'client', operation: op, reason: 'request_failed',
          elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
        reject(new Error('Background audio focus request write failed'));
      }
    });
  };
  const attach = (connected: Socket) => {
    socket = connected;
    buffer = Buffer.alloc(0);
    socket.on('error', error => {
      if (socket !== connected) return;
      if (!failed && !closed) diagnostic({ component: 'client', operation: 'connect', reason: 'socket_error',
        code: focusErrorCode(error) });
      fail();
    });
    socket.on('close', () => {
      if (socket !== connected) return;
      if (!failed && !closed) {
        const request = pending.values().next().value;
        diagnostic({ component: 'client', operation: request?.operation ?? 'idle', reason: 'socket_closed',
          ...(request ? { elapsedMs: focusElapsed(request.started) } : {}) });
      }
      fail();
    });
    socket.on('data', chunk => {
      if (socket !== connected) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FOCUS_FRAME_BYTES) {
        diagnostic({ component: 'client', operation: 'protocol', reason: 'protocol_invalid' });
        fail(); return;
      }
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        try {
          const reply = JSON.parse(frame) as { v?: unknown; id?: unknown; ok?: unknown; warning?: unknown };
          if (reply.v === 1 && typeof reply.warning === 'string' && reply.warning.length <= 256 &&
              Object.keys(reply).every(key => ['v', 'warning'].includes(key))) {
            if (isFocusDiagnosticMessage(reply.warning)) {
              const event = decodeFocusDiagnostic(reply.warning);
              if (event) diagnostic(event);
              else diagnostic({ component: 'client', operation: 'protocol', reason: 'protocol_invalid' });
            } else { try { options.onWarning?.(reply.warning); } catch {} }
            continue;
          }
          if (reply.v !== 1 || !Number.isSafeInteger(reply.id) || reply.ok !== true ||
              Object.keys(reply).some(key => !['v', 'id', 'ok'].includes(key))) throw new Error();
          const request = pending.get(reply.id as number);
          if (!request) throw new Error();
          clearTimeout(request.timer);
          pending.delete(reply.id as number);
          if (request.operation !== 'ping') diagnostic({ component: 'client', operation: request.operation,
            reason: 'acknowledged', elapsedMs: focusElapsed(request.started) });
          request.resolve();
        } catch {
          diagnostic({ component: 'client', operation: 'protocol', reason: 'protocol_invalid' });
          fail(); return;
        }
      }
    });
    heartbeat = setInterval(() => { void send('ping').catch(fail); }, FOCUS_HEARTBEAT_MS);
    heartbeat.unref();
  };
  const connect = async (path: string): Promise<Socket> => {
    const started = performance.now();
    try { await verifyFocusSocket(path, options.filesystem); }
    catch (error) {
      diagnostic({ component: 'client', operation: 'connect', reason: 'connect_failed',
        elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
      throw error;
    }
    return new Promise((resolve, reject) => {
      let connection: Socket;
      try { connection = (options.connect ?? createConnection)(path); }
      catch (error) {
        diagnostic({ component: 'client', operation: 'connect', reason: 'connect_failed',
          elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
        reject(error); return;
      }
      const timer = setTimeout(() => {
        diagnostic({ component: 'client', operation: 'connect', reason: 'connect_timeout',
          elapsedMs: focusElapsed(started), timeoutMs: 400 });
        connection.destroy(); reject(new Error('Focus connect timed out'));
      }, 400);
      connection.once('error', error => {
        clearTimeout(timer);
        diagnostic({ component: 'client', operation: 'connect', reason: 'connect_failed',
          elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
        reject(error);
      });
      connection.once('connect', () => {
        clearTimeout(timer);
        diagnostic({ component: 'client', operation: 'connect', reason: 'connected', elapsedMs: focusElapsed(started) });
        resolve(connection);
      });
    });
  };
  const open = async () => {
    const env = { ...(options.env ?? process.env) };
    try { assertDefaultFocusEnvironment(env); }
    catch (error) {
      diagnostic({ component: 'client', operation: 'environment', reason: 'environment_rejected' });
      throw error;
    }
    let path: string;
    const started = performance.now();
    try {
      path = await focusSocketPath(options.runtimeDir ??
        await focusRuntimeDirectory(env, options.filesystem), options.filesystem);
    } catch (error) {
      diagnostic({ component: 'client', operation: 'runtime', reason: 'runtime_rejected',
        elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
      throw error;
    }
    if (closed || !current) return;
    let connected: Socket;
    try { connected = await connect(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      if (closed || !current) return;
      const safeEnv = focusSpawnEnvironment(env);
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      let child: ChildProcess;
      try {
        child = (options.spawn ?? spawnProcess)(process.execPath,
          [fileURLToPath(new URL(`./audio-focus-broker.${extension}`, import.meta.url))],
          { env: safeEnv, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      } catch (error) {
        diagnostic({ component: 'client', operation: 'spawn', reason: 'spawn_failed', code: focusErrorCode(error) });
        throw error;
      }
      diagnostic({ component: 'client', operation: 'spawn', reason: 'spawned' });
      child.on('error', error => {
        diagnostic({ component: 'client', operation: 'spawn', reason: 'spawn_failed', code: focusErrorCode(error) });
        if (!closed) warning();
      });
      child.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message) ||
            message.type !== 'paj-voice-focus-diagnostic' || !('event' in message)) return;
        const event = safeFocusDiagnostic(message.event);
        if (event) diagnostic(event);
      });
      child.on('exit', (code, signal) => diagnostic({ component: 'broker', operation: 'startup', reason: 'broker_exit',
        ...(typeof code === 'number' && code >= 0 && code <= 255 ? { exitCode: code } : {}),
        ...(signal ? { signal: focusSignal(signal) } : {}), elapsedMs: focusElapsed(started) }));
      child.channel?.unref();
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
    try { assertDefaultFocusEnvironment(options.env ?? process.env); }
    catch {
      diagnostic({ component: 'client', operation: 'environment', reason: 'environment_rejected' });
      fail(); return;
    }
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
        const started = performance.now();
        try { await send('close'); }
        catch (error) {
          diagnostic({ component: 'client', operation: 'close', reason: 'cleanup_failed',
            elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
          warning();
        }
      }
      fail();
      await opening;
    })();
    return closePromise;
  };
  return { playing, idle, close };
}
