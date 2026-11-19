import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FocusAssociatedClient, FocusGraph, FocusStream } from './audio-focus-types.ts';
import { isFocusMetadataLabel } from './audio-focus-types.ts';
import { focusElapsed, focusErrorCode, focusSignal, safeFocusDiagnostic } from './audio-focus-diagnostics.ts';
import type { FocusDiagnostic } from './audio-focus-diagnostics.ts';

export interface FocusCommandLimits { timeoutMs: number; maxOutputBytes: number }
export interface FocusCommandResult {
  stdout: string;
  exitCode: number;
  signal?: string;
  timedOut?: boolean;
  errorCode?: FocusDiagnostic['code'];
}
export interface PipeWireFocusOptions {
  execute?: (file: string, args: string[], limits: FocusCommandLimits) => Promise<FocusCommandResult>;
  onDiagnostic?: (event: FocusDiagnostic) => void;
  dumpPath?: string;
  controlPath?: string;
}
const limits = { timeoutMs: 1800, maxOutputBytes: 4 * 1024 * 1024 };
const execute: NonNullable<PipeWireFocusOptions['execute']> = (file, args, bounds) =>
  new Promise(resolve => {
    execFile(file, args, { timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes,
      killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
      resolve({ exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0,
        stdout: error ? '' : stdout,
        ...(error ? { errorCode: focusErrorCode(error),
          timedOut: error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          ...(error.signal ? { signal: error.signal } : {}) } : {}) });
    });
  });
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const token = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_.@+-]+$/u.test(value);
const optionalToken = (value: unknown): value is string => value === '' || token(value);
const protectedRoles = new Set(['communication', 'phone', 'alert', 'emergency', 'notification',
  'event', 'accessibility', 'alarm', 'ringtone', 'voice']);
const normalizedRole = (role: string) => role.toLowerCase().replace(/[^a-z]/gu, '');
const protectedRole = (role: string) => protectedRoles.has(normalizedRole(role));
const ownStream = (appId: string, name: string) => appId === 'org.paj.voice' || name.startsWith('paj_voice_play');
const serial = (value: unknown): string | undefined => integer(value) ? String(value)
  : typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(value)
    && BigInt(value) <= 18446744073709551615n ? value : undefined;
const gains = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0
  && value.length <= 64 && value.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 16);
interface ObjectIndex {
  ids: Map<number, Record<string, unknown> | undefined>;
  serials: Map<string, number>;
}
function clientFor(props: Record<string, unknown>, objects: ObjectIndex, source: 'node' | 'client'):
    FocusAssociatedClient | undefined {
  const id = serial(props['client.id']);
  if (id === undefined || BigInt(id) > 0xffffffffn) return;
  const client = objects.ids.get(Number(id)), clientProps = record(record(client?.info)?.props);
  if (client?.type !== 'PipeWire:Interface:Client' || !clientProps) return;
  const objectSerial = serial(clientProps['object.serial']);
  if (!objectSerial || objects.serials.get(objectSerial) !== 1) return;
  const get = (key: string) => clientProps[key] === undefined ? '' : clientProps[key];
  const appId = get('application.id'), binary = get('application.process.binary');
  const role = get('media.role'), name = get('node.name'), appName = get('application.name');
  if (!optionalToken(appId) || !optionalToken(binary) || !optionalToken(role)
      || !isFocusMetadataLabel(name) || !isFocusMetadataLabel(appName) || ownStream(appId, name)
      || ownStream('', appName) || Object.hasOwn(clientProps, 'paj.voice.owner')) return;
  return { id: Number(id), serial: objectSerial, source, appId, binary, role, name, applicationName: appName };
}
function parseNode(value: unknown, objects: ObjectIndex): FocusStream | undefined {
  const node = record(value), info = record(node?.info), props = record(info?.props);
  const params = record(info?.params), entries = params?.Props;
  if (node?.type !== 'PipeWire:Interface:Node' || !integer(node.id) || (node.id as number) > 0xffffffff
      || props?.['media.class'] !== 'Stream/Output/Audio' || !Array.isArray(entries)
      || entries.length !== 1) return;
  const state = record(entries[0]), id = serial(props['object.serial']);
  const appId = props['application.id'] === undefined ? '' : props['application.id'];
  const binary = props['application.process.binary'] === undefined ? '' : props['application.process.binary'];
  const role = props['media.role'] === undefined ? '' : props['media.role'], name = props['node.name'];
  const appName = props['application.name'] === undefined ? '' : props['application.name'];
  if (!id || !optionalToken(appId) || !optionalToken(binary)
      || !optionalToken(role) || !isFocusMetadataLabel(name) || !name
      || !isFocusMetadataLabel(appName) || ownStream(appId, name) || ownStream('', appName)
      || Object.hasOwn(props, 'paj.voice.owner') || !gains(state?.channelVolumes) || typeof state?.mute !== 'boolean') return;
  const source = !appId && !binary ? 'client' : 'node';
  const associatedClient = Object.hasOwn(props, 'client.id') ? clientFor(props, objects, source) : undefined;
  if (Object.hasOwn(props, 'client.id') && !associatedClient) return;
  return { serial: id, id: node.id as number,
    appId: source === 'client' ? associatedClient?.appId ?? '' : appId,
    binary: source === 'client' ? associatedClient?.binary ?? '' : binary, role, name,
    volumes: [...state.channelVolumes], muted: state.mute,
    ...(associatedClient ? { associatedClient } : {}) };
}
export function createPipeWireFocusGraph(options: PipeWireFocusOptions = {}): FocusGraph {
  const run = options.execute ?? execute;
  const diagnostic = (event: FocusDiagnostic) => {
    const safe = safeFocusDiagnostic(event);
    if (safe) { try { options.onDiagnostic?.(safe); } catch {} }
  };
  return {
    async snapshot() {
      const started = performance.now();
      let result: FocusCommandResult;
      try {
        result = await run(options.dumpPath
          ?? fileURLToPath(new URL('../../../libexec/paj-voice-pw-dump', import.meta.url)),
          ['--no-colors'], limits);
      } catch (error) {
        diagnostic({ component: 'helper', operation: 'snapshot', reason: 'snapshot_failed',
          elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
        throw new Error('PipeWire snapshot unavailable');
      }
      if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > limits.maxOutputBytes) {
        diagnostic({ component: 'helper', operation: 'snapshot', reason: 'snapshot_failed',
          elapsedMs: focusElapsed(started), timeoutMs: limits.timeoutMs,
          ...(Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255
            ? { exitCode: result.exitCode } : {}),
          ...(result.signal ? { signal: focusSignal(result.signal) } : {}),
          ...(result.errorCode ? { code: focusErrorCode({ code: result.errorCode }) } : {}) });
        throw new Error('PipeWire snapshot unavailable');
      }
      let entries: unknown;
      try { entries = JSON.parse(result.stdout); }
      catch {
        diagnostic({ component: 'helper', operation: 'snapshot', reason: 'snapshot_invalid', elapsedMs: focusElapsed(started) });
        throw new Error('Invalid PipeWire snapshot');
      }
      if (!Array.isArray(entries) || entries.length > 32768) {
        diagnostic({ component: 'helper', operation: 'snapshot', reason: 'snapshot_invalid', elapsedMs: focusElapsed(started) });
        throw new Error('Invalid PipeWire snapshot');
      }
      const cores = entries.map(record).filter(v => v?.type === 'PipeWire:Interface:Core');
      const cookie = record(cores[0]?.info)?.cookie;
      if (cores.length !== 1 || !integer(cookie) || (cookie as number) > 0xffffffff) {
        diagnostic({ component: 'helper', operation: 'snapshot', reason: 'snapshot_invalid', elapsedMs: focusElapsed(started) });
        throw new Error('Missing PipeWire core cookie');
      }
      const objects: ObjectIndex = { ids: new Map(), serials: new Map() };
      for (const value of entries) {
        const entry = record(value), id = entry?.id;
        if (integer(id)) objects.ids.set(id as number, objects.ids.has(id as number) ? undefined : entry);
        const objectSerial = serial(record(record(entry?.info)?.props)?.['object.serial']);
        if (objectSerial) objects.serials.set(objectSerial, (objects.serials.get(objectSerial) ?? 0) + 1);
      }
      const streams = entries.map(entry => parseNode(entry, objects)).filter((v): v is FocusStream => v !== undefined);
      return { generation: String(cookie), streams: streams.filter(v =>
        objects.ids.get(v.id) !== undefined && objects.serials.get(v.serial) === 1) };
    },
    async compareAndSet(generation, stream, volumes, restore = false, allOtherPlayback = false) {
      const started = performance.now();
      const operation = restore ? 'restore' : 'set';
      const reject = () => {
        diagnostic({ component: 'helper', operation, reason: 'policy_rejected', elapsedMs: focusElapsed(started) });
        return false;
      };
      if (typeof generation !== 'string' || !/^(0|[1-9][0-9]{0,9})$/u.test(generation)
          || Number(generation) > 0xffffffff || !stream || typeof stream.serial !== 'string'
          || !serial(stream.serial) || !integer(stream.id) || stream.id > 0xffffffff
          || ![stream.appId, stream.binary, stream.role].every(optionalToken)
          || (!stream.appId && !stream.binary && !allOtherPlayback && !restore)
          || !isFocusMetadataLabel(stream.name) || !stream.name
          || !gains(stream.volumes) || !gains(volumes) || volumes.length !== stream.volumes.length
          || typeof stream.muted !== 'boolean' || typeof restore !== 'boolean' || typeof allOtherPlayback !== 'boolean'
          || ((stream.muted || (protectedRole(stream.role) && !allOtherPlayback)) && !restore)
          || (restore && volumes.some((value, index) => value < stream.volumes[index]!))
          || ownStream(stream.appId, stream.name))
        return reject();
      const client = stream.associatedClient;
      if (client !== undefined && (!record(client) || !integer(client.id) || client.id > 0xffffffff
          || client.id === stream.id || !serial(client.serial) || client.serial === stream.serial
          || typeof client.serial !== 'string' || !['node', 'client'].includes(client.source)
          || ![client.appId, client.binary, client.role].every(optionalToken)
          || !isFocusMetadataLabel(client.name) || !isFocusMetadataLabel(client.applicationName)
          || ownStream(client.appId, client.name)
          || ownStream('', client.applicationName) || (protectedRole(client.role) && !restore && !allOtherPlayback)
          || (client.source === 'client' && (stream.appId !== client.appId || stream.binary !== client.binary)))) return reject();
      try {
        const result = await run(options.controlPath
          ?? fileURLToPath(new URL('../../../bin/paj-voice-focus-control', import.meta.url)), [generation, stream.serial, String(stream.id), stream.appId,
          stream.binary, stream.role, stream.name, stream.muted ? '1' : '0',
          stream.volumes.join(','), volumes.join(','), restore ? '1' : '0',
          ...(client ? [client.source, String(client.id), client.serial, client.appId, client.binary,
            client.role, client.name, client.applicationName] : []),
          ...(allOtherPlayback ? ['1'] : [])], { timeoutMs: 1800, maxOutputBytes: 1024 });
        const acknowledged = result.exitCode === 0 && result.stdout === 'ok\n';
        if (!acknowledged) diagnostic({ component: 'helper', operation,
          reason: result.timedOut ? 'helper_timeout' : result.exitCode !== 0 ? 'helper_exit' : 'helper_ack_invalid',
          elapsedMs: focusElapsed(started), timeoutMs: 1800,
          ...(Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255
            ? { exitCode: result.exitCode } : {}),
          ...(result.signal ? { signal: focusSignal(result.signal) } : {}),
          ...(result.errorCode ? { code: focusErrorCode({ code: result.errorCode }) } : {}) });
        return acknowledged;
      } catch (error) {
        diagnostic({ component: 'helper', operation, reason: 'helper_exception',
          elapsedMs: focusElapsed(started), code: focusErrorCode(error) });
        return false;
      }
    },
  };
}
