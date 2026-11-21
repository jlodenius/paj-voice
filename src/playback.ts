export interface PlaybackRequest {
  id: string;
  text: string;
  generation?: string | null;
  epoch?: number;
  key?: string;
}

export interface PlaybackRecord extends PlaybackRequest {
  status: "queued" | "started" | "not_queued" | "completed" | "interrupted";
  started: boolean;
  reason?: string;
}

export function createPlaybackHistory() {
  const records = new Map<string, PlaybackRecord>();
  const active = (
    record: PlaybackRecord | undefined,
  ): record is PlaybackRecord =>
    !!record && ["queued", "started"].includes(record.status);
  return {
    queued({ id, text, generation, epoch, key }: PlaybackRequest) {
      records.set(id, {
        id,
        text: text.trim(),
        generation,
        epoch,
        ...(key ? { key } : {}),
        status: "queued",
        started: false,
      });
      while (records.size > 16) records.delete(records.keys().next().value!);
    },
    unplayed(record: PlaybackRequest, reason: string) {
      if (records.has(record.id)) return;
      this.queued(record);
      const entry = records.get(record.id)!;
      entry.status = "not_queued";
      entry.reason = reason;
    },
    started(id: string) {
      const record = records.get(id);
      if (active(record)) {
        record.status = "started";
        record.started = true;
      }
    },
    ended(id: string, completed: unknown, reason = "not_completed") {
      const record = records.get(id);
      if (!active(record)) return;
      record.status = completed === true ? "completed" : "interrupted";
      if (completed !== true) record.reason = reason;
    },
    interrupt(reason: string) {
      for (const record of records.values()) {
        if (active(record)) {
          record.status = "interrupted";
          record.reason = reason;
        }
      }
    },
    snapshot() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    clear() {
      records.clear();
    },
  };
}
