const reasons = [
  "graph_query_failed",
  "source_unresolved",
  "source_changed",
  "target_unresolved",
  "target_changed",
  "capture_eof",
  "capture_stall",
  "capture_stale_queue",
  "capture_overflow",
  "capture_discontinuity",
  "capture_process_exit",
  "capture_dc_corruption",
  "capture_processing_failed",
  "capture_health_failed",
  "output_health_failed",
  "input_warmup_timeout",
  "input_recovered",
  "output_recovered",
] as const;
const flags = [
  "inputPresent",
  "outputPresent",
  "inputChanged",
  "outputChanged",
] as const;
const keys = ["type", "v", "reason", ...flags, "pcmAgeMs", "recoveryCount"];

export interface AvailabilityDiagnostic {
  type: "availability_diagnostic";
  v: 1;
  reason: (typeof reasons)[number];
  inputPresent: boolean | null;
  outputPresent: boolean | null;
  inputChanged: boolean | null;
  outputChanged: boolean | null;
  pcmAgeMs: number | null;
  recoveryCount: number;
}

export function safeAvailabilityDiagnostic(
  value: unknown,
): AvailabilityDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some(
        (key) =>
          !descriptors[key] || !Object.hasOwn(descriptors[key]!, "value"),
      )
    )
      return;
    const event = Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value]),
    );
    if (
      event.type !== "availability_diagnostic" ||
      event.v !== 1 ||
      !reasons.includes(event.reason)
    )
      return;
    if (
      flags.some(
        (key) => event[key] !== null && typeof event[key] !== "boolean",
      )
    )
      return;
    if (
      event.reason === "graph_query_failed" &&
      flags.some((key) => event[key] !== null)
    )
      return;
    if (
      event.pcmAgeMs !== null &&
      (!Number.isInteger(event.pcmAgeMs) ||
        event.pcmAgeMs < 0 ||
        event.pcmAgeMs > 60_000)
    )
      return;
    if (
      !Number.isInteger(event.recoveryCount) ||
      event.recoveryCount < 0 ||
      event.recoveryCount > 2_147_483_647
    )
      return;
    return event as AvailabilityDiagnostic;
  } catch {
    return;
  }
}

export function createAvailabilityDiagnosticLog(
  now = () => performance.now(),
  wallNow = () => Date.now(),
) {
  const entries: {
    event: AvailabilityDiagnostic;
    at: number;
    recordedAtMs: number;
    scope: object;
  }[] = [];
  const prune = (time: number) => {
    while (entries.length && time - entries[0]!.at >= 900_000) entries.shift();
  };
  return {
    record(value: unknown, scope: object) {
      const event = safeAvailabilityDiagnostic(value);
      if (!event) return;
      const time = now();
      prune(time);
      entries.push({ event, at: time, recordedAtMs: wallNow(), scope });
      while (entries.length > 32) entries.shift();
    },
    snapshot(scope?: object) {
      const time = now();
      prune(time);
      const events = entries.map((entry) => ({
        ...entry.event,
        recordedAtMs: entry.recordedAtMs,
        ageMs: Math.max(0, Math.min(900_000, Math.round(time - entry.at))),
        currentConnection: scope !== undefined && scope === entry.scope,
      }));
      const counts: Partial<Record<AvailabilityDiagnostic["reason"], number>> =
        {};
      for (const event of events)
        counts[event.reason] = (counts[event.reason] ?? 0) + 1;
      const currentCount = events.filter(
        (event) => event.currentConnection,
      ).length;
      return {
        state: currentCount ? "observed" : "not_observed",
        connection: scope ? "active" : "inactive",
        retainedCount: events.length,
        currentCount,
        counts,
        latest: events.at(-1) ?? null,
        entries: events,
      };
    },
    clear() {
      entries.length = 0;
    },
  };
}
