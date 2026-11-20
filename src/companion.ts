import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { errorCode } from './types.ts';
import type { CompanionCommand, CompanionFrame } from './types.ts';

export interface CompanionOptions {
  config: Record<string, unknown>;
  generation: string | null;
  onEvent(frame: CompanionFrame, generation: string | null): void;
  onExit?(message: string | null): void;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  startupMs?: number;
  executable?: string;
  cacheDir?: string;
}
import { runtimePaths } from './runtime-paths.ts';

export function startCompanion({ config, generation, onEvent, onExit, spawnProcess = spawn, startupMs = 120000,
  executable = runtimePaths().executable, cacheDir = runtimePaths().cacheDir }: CompanionOptions) {
  const child = spawnProcess(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
  } });
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
  let closed = false;
  let exited = false;
  let reported = false;
  let buffer = '';
  let stderr = '';
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (message: string | null) => {
    if (reported) return;
    reported = true;
    clearTimeout(startupTimer);
    onExit?.(message);
  };
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(startupTimer);
    try {
      if (child.stdin.writable && !child.stdin.destroyed && child.stdin.writableLength < 65500) {
        child.stdin.write('{"type":"shutdown"}\n');
      }
      child.stdin.end();
    } catch {}
    if (exited) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2000);
    killTimer.unref?.();
  }
  const fail = (message: string) => {
    close();
    finish(message);
  };
  const send = (frame: CompanionCommand) => {
    if (closed || !child.stdin.writable || child.stdin.destroyed) return false;
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) + child.stdin.writableLength > 65536) {
      fail('Local voice runtime input queue overflowed. Voice stopped.');
      return false;
    }
    try { child.stdin.write(line); }
    catch { fail('Local voice runtime input disconnected. Voice stopped.'); return false; }
    return true;
  };
  child.stdin.on('error', () => fail('Local voice runtime input disconnected. Voice stopped.'));
  child.stderr.setEncoding('utf8');
  child.stderr.on('error', () => fail('Local voice runtime diagnostics disconnected. Voice stopped.'));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('error', () => fail('Local voice runtime output disconnected. Voice stopped.'));
  child.stdout.on('end', () => { if (!closed) fail('Local voice runtime output disconnected. Voice stopped.'); });
  child.stdout.on('data', chunk => {
    if (closed) return;
    buffer += chunk;
    let newline;
    while (!closed && (newline = buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, newline)) > 65536) return fail('Invalid local voice runtime frame.');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { return fail('Invalid local voice runtime frame.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('Invalid local voice runtime frame.');
      const frame: CompanionFrame = parsed;
      if (frame.type === 'ready') clearTimeout(startupTimer);
      try { onEvent(frame, generation); }
      catch { fail('Local voice runtime event handling failed. Voice stopped.'); }
    }
    if (Buffer.byteLength(buffer) > 65536) fail('Invalid local voice runtime frame.');
  });
  child.on('error', error => fail(`Cannot start local voice runtime: ${errorCode(error) ?? 'process error'}`));
  const acknowledgeTermination = () => {
    exited = true;
    resolveClosed();
    clearTimeout(killTimer);
  };
  child.on('exit', () => {
    acknowledgeTermination();
    finish(closed ? null : 'Local voice runtime exited. Check model/device configuration.');
  });
  // Failed spawns emit close after error, but never emit exit.
  child.on('close', acknowledgeTermination);
  startupTimer = setTimeout(() => fail('Local voice runtime did not become ready in time.'), startupMs);
  startupTimer.unref?.();
  send({ type: 'configure', generation, config: { ...config, cacheDir } });
  return { send, close, waitClosed: () => closedPromise, diagnostics: () => stderr };
}
