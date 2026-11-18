import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FocusGraph, FocusStream } from './audio-focus-types.ts';

export interface FocusCommandLimits { timeoutMs: number; maxOutputBytes: number }
export interface PipeWireFocusOptions {
  execute?: (file: string, args: string[], limits: FocusCommandLimits) =>
    Promise<{ stdout: string; exitCode: number }>;
  dumpPath?: string;
  controlPath?: string;
}
const limits = { timeoutMs: 1800, maxOutputBytes: 4 * 1024 * 1024 };
const execute: NonNullable<PipeWireFocusOptions['execute']> = (file, args, bounds) =>
  new Promise(resolve => {
    execFile(file, args, { timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes,
      killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
      resolve({ exitCode: error ? 1 : 0, stdout: error ? '' : stdout });
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
function parseNode(value: unknown): FocusStream | undefined {
  const node = record(value), info = record(node?.info), props = record(info?.props);
  const params = record(info?.params), entries = params?.Props;
  if (node?.type !== 'PipeWire:Interface:Node' || !integer(node.id) || (node.id as number) > 0xffffffff
      || props?.['media.class'] !== 'Stream/Output/Audio' || !Array.isArray(entries)
      || entries.length !== 1) return;
  const state = record(entries[0]), id = serial(props['object.serial']);
  const appId = props['application.id'] === undefined ? '' : props['application.id'];
  const binary = props['application.process.binary'] === undefined ? '' : props['application.process.binary'];
  const role = props['media.role'] === undefined ? '' : props['media.role'], name = props['node.name'];
  if (!id || !optionalToken(appId) || !optionalToken(binary) || (!appId && !binary)
      || !optionalToken(role) || !token(name) || ownStream(appId, name)
      || Object.hasOwn(props, 'paj.voice.owner') || !gains(state?.channelVolumes) || typeof state?.mute !== 'boolean') return;
  return { serial: id, id: node.id as number, appId, binary, role, name,
    volumes: [...state.channelVolumes], muted: state.mute };
}
export function createPipeWireFocusGraph(options: PipeWireFocusOptions = {}): FocusGraph {
  const run = options.execute ?? execute;
  return {
    async snapshot() {
      let result: { stdout: string; exitCode: number };
      try {
        result = await run(options.dumpPath
          ?? fileURLToPath(new URL('../../../libexec/paj-voice-pw-dump', import.meta.url)),
          ['--no-colors'], limits);
      } catch { throw new Error('PipeWire snapshot unavailable'); }
      if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > limits.maxOutputBytes)
        throw new Error('PipeWire snapshot unavailable');
      let entries: unknown;
      try { entries = JSON.parse(result.stdout); }
      catch { throw new Error('Invalid PipeWire snapshot'); }
      if (!Array.isArray(entries) || entries.length > 32768) throw new Error('Invalid PipeWire snapshot');
      const cores = entries.map(record).filter(v => v?.type === 'PipeWire:Interface:Core');
      const cookie = record(cores[0]?.info)?.cookie;
      if (cores.length !== 1 || !integer(cookie) || (cookie as number) > 0xffffffff)
        throw new Error('Missing PipeWire core cookie');
      const streams = entries.map(parseNode).filter((v): v is FocusStream => v !== undefined);
      const ids = new Map<number, number>(), serials = new Map<string, number>();
      for (const stream of streams) {
        ids.set(stream.id, (ids.get(stream.id) ?? 0) + 1);
        serials.set(stream.serial, (serials.get(stream.serial) ?? 0) + 1);
      }
      return { generation: String(cookie), streams: streams.filter(v =>
        ids.get(v.id) === 1 && serials.get(v.serial) === 1) };
    },
    async compareAndSet(generation, stream, volumes, restore = false) {
      if (typeof generation !== 'string' || !/^(0|[1-9][0-9]{0,9})$/u.test(generation)
          || Number(generation) > 0xffffffff || !stream || typeof stream.serial !== 'string'
          || !serial(stream.serial) || !integer(stream.id) || stream.id > 0xffffffff
          || ![stream.appId, stream.binary, stream.role].every(optionalToken)
          || (!stream.appId && !stream.binary) || !token(stream.name)
          || !gains(stream.volumes) || !gains(volumes) || volumes.length !== stream.volumes.length
          || typeof stream.muted !== 'boolean' || typeof restore !== 'boolean'
          || ((protectedRole(stream.role) || stream.muted) && !restore)
          || (restore && volumes.some((value, index) => value < stream.volumes[index]!))
          || ownStream(stream.appId, stream.name))
        return false;
      try {
        const result = await run(options.controlPath
          ?? fileURLToPath(new URL('../../../bin/paj-voice-focus-control', import.meta.url)), [generation, stream.serial, String(stream.id), stream.appId,
          stream.binary, stream.role, stream.name, stream.muted ? '1' : '0',
          stream.volumes.join(','), volumes.join(','), restore ? '1' : '0'], { timeoutMs: 1800, maxOutputBytes: 1024 });
        return result.exitCode === 0 && result.stdout === 'ok\n';
      } catch { return false; }
    },
  };
}
