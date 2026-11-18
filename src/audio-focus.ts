import type { BackgroundAudioSettings, FocusGraph, FocusStream, FocusPreview } from './audio-focus-types.ts';
import { validateBackgroundAudio } from './config.ts';

const printable = (value: string) => typeof value === 'string' && /^[\x20-\x7e]{1,256}$/.test(value);
const roles = new Set(['communication', 'phone', 'alert', 'emergency', 'notification', 'event',
  'accessibility', 'alarm', 'ringtone', 'voice']);
const sameVector = (a: number[], b: number[]) => a.length === b.length
  && a.every((v, i) => Math.abs(v - b[i]!) <= 1e-6 * Math.max(1, Math.abs(v), Math.abs(b[i]!)));
const identity = (a: FocusStream, b: FocusStream) => a.serial === b.serial && a.id === b.id
  && a.appId === b.appId && a.binary === b.binary && a.role === b.role && a.name === b.name;
const matches = (apps: string[], stream: FocusStream) => apps.includes(stream.appId) || apps.includes(stream.binary);
function supported(stream: FocusStream) {
  return printable(stream.serial) && Number.isSafeInteger(stream.id) && stream.id >= 0
    && (stream.appId === '' || printable(stream.appId)) && (stream.binary === '' || printable(stream.binary))
    && stream.volumes.length > 0 && stream.volumes.length <= 64
    && Array.from(stream.volumes).every(v => Number.isFinite(v) && v >= 0 && v <= 4)
    && typeof stream.muted === 'boolean';
}
function applicationSelector(stream: FocusStream): string | undefined {
  for (const value of [stream.appId, stream.binary]) {
    if (!value) continue;
    try { return validateBackgroundAudio({ apps: [value] }).apps[0]; } catch {}
  }
  return undefined;
}
function voiceStream(stream: FocusStream) {
  return stream.appId === 'org.paj.voice' || stream.name.startsWith('paj_voice_play');
}
function protectedStream(stream: FocusStream) {
  return stream.muted || voiceStream(stream)
    || roles.has(stream.role.toLowerCase().replace(/[^a-z]/g, ''));
}
export function createAudioFocus(graph: FocusGraph, options: {
  pollMs?: number; releaseMs?: number; onWarning?: (message: string) => void;
} = {}) {
  const owners = new Map<string, BackgroundAudioSettings>();
  const owned = new Map<string, { baseline: number[]; stream: FocusStream }>();
  const tombstones = new Set<string>();
  let closed = false;
  let failed = false;
  let cycleGeneration: string | undefined;
  let dirty = false;
  let revision = 0;
  let running: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  const pollMs = Number.isFinite(options.pollMs) ? Math.min(60_000, Math.max(1, options.pollMs!)) : 500;
  const releaseMs = Number.isFinite(options.releaseMs) ? Math.min(60_000, Math.max(0, options.releaseMs!)) : 200;
  const warn = (message: string) => { try { options.onWarning?.(message); } catch {} };
  let restorationWarning = false;
  function warnUnconfirmed(reason: string) {
    if (restorationWarning) return;
    restorationWarning = true;
    warn(`${reason}; restoration is not confirmed. Audio may remain quiet; adjust application volume manually if needed.`);
  }
  let saturated = false;
  function resetIdleCycle() {
    if (owners.size || owned.size || release) return;
    failed = false;
    cycleGeneration = undefined;
    tombstones.clear();
    saturated = false;
  }
  function tombstone(key: string) {
    if (tombstones.size < 128) tombstones.add(key);
    else saturated = true;
  }
  function gainFor(stream: FocusStream, settings: BackgroundAudioSettings[]) {
    if (protectedStream(stream) || settings.some(s => matches(s.excludeApps, stream))) return undefined;
    const gains = settings.filter(s => s.mode === 'duck' && matches(s.apps, stream)).map(s => s.gain);
    return gains.length ? Math.min(...gains) : undefined;
  }
  async function reconcile() {
    if (failed) return;
    const version = revision;
    const snapshot = await graph.snapshot();
    if (version !== revision) return;
    if (!printable(snapshot.generation)) throw new Error('Invalid graph generation');
    if (cycleGeneration !== undefined && snapshot.generation !== cycleGeneration) {
      failed = true;
      owned.clear();
      warnUnconfirmed('Audio focus graph generation changed; old leases will not be replayed');
      return;
    }
    if (owners.size || owned.size || release) cycleGeneration ??= snapshot.generation;
    const streams = snapshot.streams.slice(0, 128);
    const keyFor = (stream: FocusStream) => JSON.stringify([snapshot.generation, stream.serial]);
    const present = new Map(streams.map(stream => [keyFor(stream), stream]));
    for (const [key, held] of owned) {
      const current = present.get(key);
      if (!current || !supported(current) || current.id !== held.stream.id
        || !sameVector(current.volumes, held.stream.volumes)) {
        owned.delete(key);
        tombstone(key);
      }
    }
    for (const stream of streams) {
      if (version !== revision) return;
      const key = keyFor(stream);
      if (!supported(stream) || tombstones.has(key)) continue;
      const held = owned.get(key);
      if (saturated && !held) continue;
      if (voiceStream(stream)) {
        if (held) {
          owned.delete(key);
          tombstone(key);
          warnUnconfirmed('Audio focus stream became protected Voice audio');
        }
        continue;
      }
      const contextChanged = held && (!identity(stream, held.stream) || stream.muted !== held.stream.muted);
      const gain = contextChanged ? undefined : gainFor(stream, [...owners.values()]);
      if (release && !owners.size && held && !contextChanged && !protectedStream(stream)) continue;
      if (gain === undefined && !held) continue;
      const baseline = held?.baseline ?? [...stream.volumes];
      const volumes = gain === undefined ? baseline : baseline.map(v => v * gain);
      if (sameVector(volumes, stream.volumes)) {
        if (gain === undefined) { owned.delete(key); tombstone(key); }
        continue;
      }
      const acknowledged = await graph.compareAndSet(snapshot.generation, stream, volumes,
        held !== undefined && gain === undefined);
      if (!acknowledged) {
        owned.delete(key);
        tombstone(key);
        warnUnconfirmed('Audio focus write acknowledgement was not confirmed');
      } else if (gain !== undefined) {
        owned.set(key, { baseline, stream: { ...stream, volumes: [...volumes] } });
      } else { owned.delete(key); tombstone(key); }
    }
  }
  function schedulePoll() {
    if (poll) clearTimeout(poll);
    poll = undefined;
    if (!closed && (owners.size || owned.size)) {
      poll = setTimeout(() => { poll = undefined; void request(); }, pollMs);
      poll.unref?.();
    }
  }
  function request(): Promise<void> {
    dirty = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        while (dirty) {
          dirty = false;
          try { await reconcile(); }
          catch {
            warnUnconfirmed('Audio focus graph failed; ownership relinquished without stale replay');
            failed = true;
            owned.clear();
          }
          resetIdleCycle();
        }
      }).finally(() => { running = undefined; schedulePoll(); });
    }
    return running;
  }
  return {
    async set(owner: string, settings: BackgroundAudioSettings | null, immediate = false): Promise<void> {
      if (closed) throw new Error('Audio focus is closed');
      if (!printable(owner)) throw new Error('Invalid audio focus owner');
      const validated = settings === null ? null : validateBackgroundAudio(settings);
      if (validated === null || validated.mode === 'off') owners.delete(owner);
      else {
        if (!owners.has(owner) && owners.size >= 32) throw new Error('Too many audio focus owners');
        owners.set(owner, validated);
      }
      revision++;
      if (owners.size || immediate) {
        if (release) clearTimeout(release);
        release = undefined;
      } else if (owned.size && !release && releaseMs > 0) {
        release = setTimeout(() => {
          release = undefined;
          revision++;
          void request();
        }, releaseMs);
        release.unref?.();
      }
      await request();
      resetIdleCycle();
    },
    async preview(settings: BackgroundAudioSettings): Promise<FocusPreview> {
      const validated = validateBackgroundAudio(settings);
      const snapshot = await graph.snapshot();
      const eligible = new Set<string>();
      const available = new Set<string>();
      let excluded = 0;
      let unsupported = Math.max(0, snapshot.streams.length - 128);
      for (const stream of snapshot.streams.slice(0, 128)) {
        if (!supported(stream)) { unsupported++; continue; }
        const id = applicationSelector(stream);
        if (!id) { unsupported++; continue; }
        if (!protectedStream(stream)) available.add(id);
        if (gainFor(stream, [validated]) === undefined) { excluded++; continue; }
        eligible.add(id);
      }
      return { available: [...available].sort(), eligible: [...eligible].sort(), excluded, unsupported };
    },
    async close(): Promise<void> {
      closed = true;
      owners.clear();
      revision++;
      if (release) clearTimeout(release);
      if (poll) clearTimeout(poll);
      release = undefined;
      poll = undefined;
      await request();
    },
  };
}
