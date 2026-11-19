const components = ['client', 'broker', 'helper'] as const;
const operations = ['environment', 'runtime', 'connect', 'spawn', 'startup', 'protocol', 'set',
  'restore', 'idle', 'ping', 'close', 'release', 'cleanup', 'snapshot'] as const;
const reasons = ['connected', 'spawned', 'acknowledged', 'environment_rejected', 'runtime_rejected', 'connect_failed', 'connect_timeout',
  'spawn_failed', 'broker_exit', 'startup_failed', 'protocol_invalid', 'ack_timeout',
  'request_unavailable', 'socket_error', 'socket_closed', 'request_failed', 'cleanup_failed',
  'cleanup_slow', 'helper_exit', 'helper_timeout', 'helper_ack_invalid', 'helper_exception',
  'policy_rejected', 'snapshot_failed', 'snapshot_invalid'] as const;
const codes = ['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ETIMEDOUT', 'EEXIST', 'ENOTDIR',
  'ENAMETOOLONG', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'other'] as const;
const signals = ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGPIPE', 'other'] as const;
const prefix = '[focus-diagnostic] ';

export interface FocusDiagnostic {
  component: typeof components[number];
  operation: typeof operations[number];
  reason: typeof reasons[number];
  elapsedMs?: number;
  timeoutMs?: number;
  exitCode?: number;
  code?: typeof codes[number];
  signal?: typeof signals[number];
}

export function safeFocusDiagnostic(value: unknown): FocusDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some(key => !['component', 'operation', 'reason', 'elapsedMs', 'timeoutMs',
    'exitCode', 'code', 'signal'].includes(key)) || !components.includes(event.component as FocusDiagnostic['component']) ||
      !operations.includes(event.operation as FocusDiagnostic['operation']) ||
      !reasons.includes(event.reason as FocusDiagnostic['reason'])) return;
  for (const key of ['elapsedMs', 'timeoutMs', 'exitCode'] as const) {
    const number = event[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isInteger(number) ||
        number < 0 || number > (key === 'exitCode' ? 255 : 600_000))) return;
  }
  if ((event.code !== undefined && !codes.includes(event.code as NonNullable<FocusDiagnostic['code']>)) ||
      (event.signal !== undefined && !signals.includes(event.signal as NonNullable<FocusDiagnostic['signal']>))) return;
  return { ...event } as unknown as FocusDiagnostic;
}

export function focusErrorCode(error: unknown): NonNullable<FocusDiagnostic['code']> {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return codes.includes(code as NonNullable<FocusDiagnostic['code']>)
    ? code as NonNullable<FocusDiagnostic['code']> : 'other';
}

export function focusSignal(signal: unknown): NonNullable<FocusDiagnostic['signal']> {
  return signals.includes(signal as NonNullable<FocusDiagnostic['signal']>)
    ? signal as NonNullable<FocusDiagnostic['signal']> : 'other';
}

export const focusElapsed = (started: number, now = performance.now()) =>
  Math.max(0, Math.min(600_000, Math.round(now - started)));

export function encodeFocusDiagnostic(event: FocusDiagnostic): string | undefined {
  const safe = safeFocusDiagnostic(event);
  if (!safe) return;
  const encoded = prefix + JSON.stringify(safe);
  return encoded.length <= 256 ? encoded : undefined;
}

export function decodeFocusDiagnostic(message: string): FocusDiagnostic | undefined {
  if (!message.startsWith(prefix) || message.length > 256) return;
  try { return safeFocusDiagnostic(JSON.parse(message.slice(prefix.length))); } catch { return; }
}

export const isFocusDiagnosticMessage = (message: string) => message.startsWith(prefix);

export function createFocusDiagnosticSender(send: (event: FocusDiagnostic, done: () => void) => void) {
  const queue: FocusDiagnostic[] = [];
  let busy = false;
  const flush = () => {
    if (busy || !queue.length) return;
    busy = true;
    try {
      send(queue.shift()!, () => { busy = false; flush(); });
    } catch {
      busy = false;
      queue.length = 0;
    }
  };
  return (event: unknown) => {
    const safe = safeFocusDiagnostic(event);
    if (!safe || queue.length >= 8) return;
    queue.push(safe);
    flush();
  };
}

export function createFocusDiagnosticLog(now = () => performance.now()) {
  const entries: { event: FocusDiagnostic; at: number }[] = [];
  const prune = () => {
    while (entries.length && now() - entries[0]!.at >= 900_000) entries.shift();
  };
  return {
    record(event: unknown) {
      const safe = safeFocusDiagnostic(event);
      if (!safe) return;
      prune();
      entries.push({ event: safe, at: now() });
      while (entries.length > 32) entries.shift();
    },
    snapshot() {
      prune();
      return entries.map(({ event, at }) => ({ ...event,
        ageMs: Math.max(0, Math.min(900_000, Math.round(now() - at))) }));
    },
    clear() { entries.length = 0; },
  };
}
