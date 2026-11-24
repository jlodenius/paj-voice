import type {
  BackgroundAudioSettings,
  FocusGraph,
  FocusStream,
  FocusPreview,
} from "./audio-focus-types.ts";
import { isFocusMetadataLabel } from "./audio-focus-types.ts";
import { validateFocusPolicy } from "./config.ts";

const printable = (value: string) =>
  typeof value === "string" && /^[\x20-\x7e]{1,256}$/.test(value);
const roles = new Set([
  "communication",
  "phone",
  "alert",
  "emergency",
  "notification",
  "event",
  "accessibility",
  "alarm",
  "ringtone",
  "voice",
]);
const sameVector = (a: number[], b: number[]) =>
  a.length === b.length &&
  a.every(
    (v, i) =>
      Math.abs(v - b[i]!) <= 1e-6 * Math.max(1, Math.abs(v), Math.abs(b[i]!)),
  );
const association = (stream: FocusStream) =>
  stream.associatedClient
    ? JSON.stringify([
        stream.associatedClient.id,
        stream.associatedClient.serial,
        stream.associatedClient.source,
      ])
    : "";
const identity = (a: FocusStream, b: FocusStream) =>
  a.serial === b.serial &&
  a.id === b.id &&
  a.appId === b.appId &&
  a.binary === b.binary &&
  a.role === b.role &&
  a.name === b.name &&
  JSON.stringify(a.associatedClient) === JSON.stringify(b.associatedClient);
const matches = (apps: string[], stream: FocusStream) =>
  apps.includes(stream.appId) || apps.includes(stream.binary);
function supported(stream: FocusStream) {
  const client = stream.associatedClient;
  if (
    client !== undefined &&
    (!client ||
      typeof client !== "object" ||
      !Number.isSafeInteger(client.id) ||
      client.id < 0 ||
      client.id > 0xffffffff ||
      client.id === stream.id ||
      !printable(client.serial) ||
      client.serial === stream.serial ||
      !["node", "client"].includes(client.source) ||
      ![client.appId, client.binary, client.role].every(
        (value) => value === "" || printable(value),
      ) ||
      !isFocusMetadataLabel(client.name) ||
      !isFocusMetadataLabel(client.applicationName))
  )
    return false;
  return (
    printable(stream.serial) &&
    Number.isSafeInteger(stream.id) &&
    stream.id >= 0 &&
    (stream.appId === "" || printable(stream.appId)) &&
    (stream.binary === "" || printable(stream.binary)) &&
    (stream.role === "" || printable(stream.role)) &&
    isFocusMetadataLabel(stream.name) &&
    stream.name !== "" &&
    Array.isArray(stream.volumes) &&
    stream.volumes.length > 0 &&
    stream.volumes.length <= 64 &&
    Array.from(stream.volumes).every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 4,
    ) &&
    typeof stream.muted === "boolean"
  );
}
function applicationSelector(stream: FocusStream): string | undefined {
  for (const value of [stream.appId, stream.binary]) {
    if (!value) continue;
    try {
      return validateFocusPolicy({ apps: [value] }).apps[0];
    } catch {}
  }
  return undefined;
}
function voiceStream(stream: FocusStream) {
  const client = stream.associatedClient;
  return (
    stream.appId === "org.paj.voice" ||
    stream.name.startsWith("paj_voice_play") ||
    (client !== undefined &&
      (client.appId === "org.paj.voice" ||
        client.name.startsWith("paj_voice_play") ||
        client.applicationName.startsWith("paj_voice_play")))
  );
}
function protectedStream(stream: FocusStream, allOtherPlayback = false) {
  return (
    stream.muted ||
    voiceStream(stream) ||
    (!allOtherPlayback &&
      [stream.role, stream.associatedClient?.role ?? ""].some((role) =>
        roles.has(role.toLowerCase().replace(/[^a-z]/g, "")),
      ))
  );
}
export function createAudioFocus(
  graph: FocusGraph,
  options: {
    pollMs?: number;
    releaseMs?: number;
    onWarning?: (message: string) => void;
  } = {},
) {
  const owners = new Map<string, BackgroundAudioSettings>();
  const owned = new Map<
    string,
    { baseline: number[]; stream: FocusStream; restoreFaults: number }
  >();
  const maxRestoreFaults = 3;
  let snapshotFaults = 0;
  let graphUnavailable = false;
  const tombstones = new Set<string>();
  let closed = false;
  let failed = false;
  let cycleGeneration: string | undefined;
  let dirty = false;
  let revision = 0;
  let running: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  const pollMs = Number.isFinite(options.pollMs)
    ? Math.min(60_000, Math.max(1, options.pollMs!))
    : 500;
  const releaseMs = Number.isFinite(options.releaseMs)
    ? Math.min(60_000, Math.max(0, options.releaseMs!))
    : 200;
  const warn = (message: string) => {
    try {
      options.onWarning?.(message);
    } catch {}
  };
  let restorationWarning = false;
  function warnUnconfirmed(reason: string) {
    if (restorationWarning) return;
    restorationWarning = true;
    warn(
      `${reason}; restoration is not confirmed. Audio may remain quiet; adjust application volume manually if needed.`,
    );
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
    if (
      protectedStream(stream, true) ||
      settings.some((s) => matches(s.excludeApps, stream))
    )
      return undefined;
    const qualifying = settings.filter(
      (s) =>
        s.mode === "duck-all" ||
        (s.mode === "duck" &&
          !protectedStream(stream) &&
          matches(s.apps, stream)),
    );
    return qualifying.length
      ? {
          gain: Math.min(...qualifying.map((s) => s.gain)),
          allOtherPlayback: qualifying.some((s) => s.mode === "duck-all"),
        }
      : undefined;
  }
  async function reconcile(version: number): Promise<boolean | undefined> {
    if (failed) return;
    const snapshot = await graph.snapshot();
    if (version !== revision) return;
    if (!printable(snapshot.generation) || !Array.isArray(snapshot.streams))
      throw new Error("Invalid graph snapshot");
    if (
      cycleGeneration !== undefined &&
      snapshot.generation !== cycleGeneration
    ) {
      failed = true;
      owned.clear();
      warnUnconfirmed(
        "Audio focus graph generation changed; old leases will not be replayed",
      );
      return;
    }
    if (owners.size || owned.size || release)
      cycleGeneration ??= snapshot.generation;
    const streams = snapshot.streams.slice(0, 128);
    const keyFor = (stream: FocusStream) =>
      JSON.stringify([snapshot.generation, stream.serial]);
    const present = new Map<string, FocusStream | undefined>();
    for (const stream of streams) {
      const key = keyFor(stream);
      present.set(key, present.has(key) ? undefined : stream);
    }
    snapshotFaults = 0;
    let retry = false;
    const restoreFault = (held: { restoreFaults: number }, reason: string) => {
      if (held.restoreFaults >= maxRestoreFaults) return;
      if (++held.restoreFaults < maxRestoreFaults) retry = true;
      else warnUnconfirmed(reason);
    };
    const incomplete = new Set<string>();
    for (const [key, held] of owned) {
      const current = present.get(key);
      if (
        !current ||
        !supported(current) ||
        (current.id === held.stream.id &&
          (current.volumes.length !== held.stream.volumes.length ||
            (held.stream.associatedClient && !current.associatedClient)))
      ) {
        // The dump omits nodes whose Props or Client are incomplete. Absence is
        // not evidence that an owned attenuation can be forgotten.
        incomplete.add(key);
        restoreFault(
          held,
          "Audio focus snapshot omitted a complete owned stream",
        );
      } else if (
        current.id !== held.stream.id ||
        association(current) !== association(held.stream) ||
        !sameVector(current.volumes, held.stream.volumes)
      ) {
        owned.delete(key);
        tombstone(key);
      }
    }
    for (const [key, stream] of present) {
      if (version !== revision) return;
      if (
        !stream ||
        !supported(stream) ||
        tombstones.has(key) ||
        incomplete.has(key)
      )
        continue;
      const held = owned.get(key);
      if (!held && (saturated || owned.size >= 128)) continue;
      if (voiceStream(stream)) {
        if (held) {
          owned.delete(key);
          tombstone(key);
          warnUnconfirmed("Audio focus stream became protected Voice audio");
        }
        continue;
      }
      const contextChanged =
        held &&
        (!identity(stream, held.stream) || stream.muted !== held.stream.muted);
      if (held && held.restoreFaults >= maxRestoreFaults) continue;
      const target = contextChanged
        ? undefined
        : gainFor(stream, [...owners.values()]);
      const gain = target?.gain;
      if (
        release &&
        !owners.size &&
        held &&
        !contextChanged &&
        !protectedStream(stream)
      )
        continue;
      if (gain === undefined && !held) continue;
      const baseline = held?.baseline ?? [...stream.volumes];
      const volumes =
        gain === undefined ? baseline : baseline.map((v) => v * gain);
      if (sameVector(volumes, stream.volumes)) {
        if (gain === undefined) {
          owned.delete(key);
          tombstone(key);
        }
        continue;
      }
      const restoring = held !== undefined && gain === undefined;
      let acknowledged = false;
      try {
        acknowledged = await graph.compareAndSet(
          snapshot.generation,
          stream,
          volumes,
          restoring,
          target?.allOtherPlayback ?? false,
        );
      } catch {}
      if (!acknowledged && restoring) {
        restoreFault(
          held,
          "Audio focus restore write acknowledgement was not confirmed",
        );
      } else if (!acknowledged) {
        owned.delete(key);
        tombstone(key);
        warnUnconfirmed("Audio focus write acknowledgement was not confirmed");
      } else if (gain !== undefined) {
        owned.set(key, {
          baseline,
          restoreFaults: 0,
          stream: {
            ...stream,
            volumes: [...volumes],
            ...(stream.associatedClient
              ? { associatedClient: { ...stream.associatedClient } }
              : {}),
          },
        });
      } else {
        owned.delete(key);
        tombstone(key);
      }
    }
    return retry;
  }
  // Exhausted streams stay fenced across owner changes without idle graph polling.
  function schedulePoll() {
    if (poll) clearTimeout(poll);
    poll = undefined;
    if (!closed && !graphUnavailable && (owners.size || release)) {
      poll = setTimeout(() => {
        poll = undefined;
        void request();
      }, pollMs);
      poll.unref?.();
    }
  }
  function request(): Promise<void> {
    dirty = true;
    if (!running) {
      running = Promise.resolve()
        .then(async () => {
          while (dirty) {
            dirty = false;
            const version = revision;
            try {
              if ((await reconcile(version)) && version === revision)
                dirty = true;
            } catch {
              if (version === revision) {
                if (++snapshotFaults < maxRestoreFaults) dirty = true;
                else {
                  graphUnavailable = true;
                  for (const held of owned.values())
                    held.restoreFaults = maxRestoreFaults;
                  if (!owned.size) failed = true;
                  warnUnconfirmed("Audio focus graph failed");
                }
              }
            }
            resetIdleCycle();
          }
        })
        .finally(() => {
          running = undefined;
          schedulePoll();
        });
    }
    return running;
  }
  return {
    async set(
      owner: string,
      settings: BackgroundAudioSettings | null,
      immediate = false,
    ): Promise<void> {
      if (closed) throw new Error("Audio focus is closed");
      if (!printable(owner)) throw new Error("Invalid audio focus owner");
      const validated =
        settings === null ? null : validateFocusPolicy(settings);
      if (validated === null || validated.mode === "off") owners.delete(owner);
      else {
        if (!owners.size && !release) {
          tombstones.clear();
          saturated = false;
        }
        if (!owners.has(owner) && owners.size >= 32)
          throw new Error("Too many audio focus owners");
        owners.set(owner, validated);
      }
      revision++;
      snapshotFaults = 0;
      graphUnavailable = false;
      if (owners.size || immediate) {
        if (release) clearTimeout(release);
        release = undefined;
      } else if (owned.size && !release && releaseMs > 0) {
        release = setTimeout(() => {
          release = undefined;
          revision++;
          snapshotFaults = 0;
          graphUnavailable = false;
          void request();
        }, releaseMs);
        release.unref?.();
      }
      await request();
      resetIdleCycle();
    },
    async preview(settings: BackgroundAudioSettings): Promise<FocusPreview> {
      const validated = validateFocusPolicy(settings);
      const snapshot = await graph.snapshot();
      const eligible = new Set<string>();
      const available = new Set<string>();
      let excluded = 0;
      let unsupported = Math.max(0, snapshot.streams.length - 128);
      for (const stream of snapshot.streams.slice(0, 128)) {
        if (!supported(stream)) {
          unsupported++;
          continue;
        }
        const allOtherPlayback = validated.mode === "duck-all";
        const id =
          applicationSelector(stream) ??
          (allOtherPlayback ? `stream:${stream.serial}` : undefined);
        if (!id) {
          unsupported++;
          continue;
        }
        if (!protectedStream(stream, allOtherPlayback)) available.add(id);
        if (gainFor(stream, [validated]) === undefined) {
          excluded++;
          continue;
        }
        eligible.add(id);
      }
      return {
        available: [...available].sort(),
        eligible: [...eligible].sort(),
        excluded,
        unsupported,
      };
    },
    hasUnconfirmedRestorations(): boolean {
      return owned.size > 0;
    },
    async close(): Promise<void> {
      if (closed) return running;
      closed = true;
      owners.clear();
      revision++;
      snapshotFaults = 0;
      if (release) clearTimeout(release);
      if (poll) clearTimeout(poll);
      release = undefined;
      poll = undefined;
      await request();
    },
  };
}
